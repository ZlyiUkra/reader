import { request } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path/posix';
import type { ThresholdsFile } from '../config/types.ts';

/**
 * The app's side of contracts/parser.md: one call, `POST /parse`, over the Unix socket in the shared jobs volume. The
 * parser is the only program that opens document bytes (constitution VII); the app only asks it to, waits, and then reads
 * what it wrote with `safe-read.ts`. Nothing here knows what a document is.
 */

/**
 * The thresholds the app needs to know how long a job may take. The parser reads all of its own numbers from the
 * thresholds file, which compose mounts into it read-only (contracts/parser.md), so the request carries only the job id;
 * the app keeps these four rows to work out the same deadline. Both read the file once at start, so a change of a
 * threshold needs a restart of both.
 */
export type ParserTimeouts = {
  convertTimeoutS: number;
  renderTimeoutSPerPage: number;
  ocrTimeoutSPerPage: number;
  pageCap: number;
};

/** The row of the thresholds file each timeout comes from. */
const timeoutKeys: Record<keyof ParserTimeouts, string> = {
  convertTimeoutS: 'parser.convert_timeout_s',
  renderTimeoutSPerPage: 'parser.render_timeout_s_per_page',
  ocrTimeoutSPerPage: 'parser.ocr_timeout_s_per_page',
  pageCap: 'parser.page_cap',
};

/** Picks the timeouts out of the validated thresholds file; a row that is not a number is a defect of the file. */
export function parserTimeouts(thresholds: ThresholdsFile): ParserTimeouts {
  const timeouts: Record<string, number> = {};
  for (const [name, key] of Object.entries(timeoutKeys)) {
    const value = thresholds.values[key]?.value;
    if (typeof value !== 'number') {
      throw new Error(`The threshold ${key} is missing or not a number`);
    }
    timeouts[name] = value;
  }
  return timeouts as ParserTimeouts;
}

/** The reasons the parser answers with: its own four and the internal error it uses when a job did not end as designed. */
export type ParserReason = 'TOO_LARGE' | 'CORRUPT' | 'ENCRYPTED' | 'UNSUPPORTED_FORMAT' | 'INTERNAL_ERROR';

/** What the parser answered: the manifest is written, or the job ended with a reason and its parameters. */
export type ParserAnswer = { ok: true } | { ok: false; code: ParserReason; params: Record<string, string | number> };

/**
 * A call that did not get an answer: the socket could not be reached or refused (`connect`), the parser stayed busy past
 * the wait (`busy`), no answer came in time (`timeout`) or the answer was not what the contract says (`protocol`). All of
 * them are infrastructure failures, which the pipeline retries; none is a verdict on the document.
 */
export class ParserClientError extends Error {
  kind: 'connect' | 'busy' | 'timeout' | 'protocol';

  constructor(kind: ParserClientError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParserClientError';
    this.kind = kind;
  }
}

/** The settings of one call; the defaults are the container's. */
export type ParseRequest = {
  socketPath: string;
  jobId: string;
  timeouts: ParserTimeouts;
  /** How long to keep asking while the parser answers 429, in milliseconds. */
  busyWaitMs?: number;
};

/** The most an answer may be: one short JSON object. */
const maxAnswerBytes = 65_536;

/** The reasons a well-formed answer may carry. */
const reasons = new Set<string>(['TOO_LARGE', 'CORRUPT', 'ENCRYPTED', 'UNSUPPORTED_FORMAT', 'INTERNAL_ERROR']);

/**
 * The longest a job may run, as the parser works it out: the conversion, plus for every page its two renders and its OCR.
 * The call waits this long and ten seconds more, so the parser's own deadline always comes first.
 */
export function jobDeadlineMs(timeouts: ParserTimeouts): number {
  return (timeouts.convertTimeoutS + timeouts.pageCap * (2 * timeouts.renderTimeoutSPerPage + timeouts.ocrTimeoutSPerPage) + 30) * 1000;
}

/** True for an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One HTTP exchange over the socket: the status, the `Retry-After` header and the parsed JSON body. */
function exchange(options: ParseRequest, timeoutMs: number): Promise<{ status: number; retryAfterS: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jobId: options.jobId });
    const call = request(
      { socketPath: options.socketPath, method: 'POST', path: '/parse', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxAnswerBytes) {
            call.destroy(new ParserClientError('protocol', 'The parser answered with more than 64 KiB'));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          try {
            const retryAfterS = Number(response.headers['retry-after'] ?? 1);
            resolve({ status: response.statusCode ?? 0, retryAfterS: Number.isFinite(retryAfterS) ? retryAfterS : 1, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
          } catch (error) {
            reject(new ParserClientError('protocol', 'The parser answered with something that is not JSON', { cause: error }));
          }
        });
      },
    );
    call.on('timeout', () => call.destroy(new ParserClientError('timeout', `The parser did not answer within ${Math.round(timeoutMs / 1000)} s`)));
    call.on('error', (error) => reject(error instanceof ParserClientError ? error : new ParserClientError('connect', `The parser socket ${options.socketPath} could not be used: ${error.message}`, { cause: error })));
    call.end(payload);
  });
}

/**
 * Asks the parser to read one job and returns its answer. A 429 means a job is already running (one at a time, C8), so
 * the call waits the parser's `Retry-After` and asks again until `busyWaitMs` has passed; any other status than 200 and
 * any answer that does not match the contract is a `ParserClientError`.
 */
export async function requestParse(options: ParseRequest): Promise<ParserAnswer> {
  const started = performance.now();
  const busyWaitMs = options.busyWaitMs ?? jobDeadlineMs(options.timeouts);
  for (;;) {
    const { status, retryAfterS, body } = await exchange(options, jobDeadlineMs(options.timeouts) + 10_000);
    if (status === 429) {
      if (performance.now() - started + retryAfterS * 1000 > busyWaitMs) {
        throw new ParserClientError('busy', 'The parser stayed busy for the whole wait');
      }
      await new Promise((resolve) => setTimeout(resolve, retryAfterS * 1000));
      continue;
    }
    if (status !== 200 || !isRecord(body) || body['jobId'] !== options.jobId || typeof body['ok'] !== 'boolean') {
      throw new ParserClientError('protocol', `The parser answered ${status} with a body the contract does not allow`);
    }
    if (body['ok']) {
      return { ok: true };
    }
    const params = body['params'];
    const code = body['code'];
    if (typeof code !== 'string' || !reasons.has(code) || !isRecord(params) || Object.values(params).some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      throw new ParserClientError('protocol', 'The parser reported a failure the contract does not allow');
    }
    return { ok: false, code: code as ParserReason, params: params as Record<string, string | number> };
  }
}

/** Where the parser listens: `parser.sock` in the shared jobs folder, the one place the app and the health probe both read. */
export function parserSocketPath(jobsDir: string): string {
  return path.join(jobsDir, 'parser.sock');
}

/**
 * Whether the parser is there (FR-065): true when its socket accepts a connection, which is closed at once, so the parser
 * sees an empty connection and starts no job (a parse is always a `POST /parse`). A missing socket file, a refused connection,
 * any other error and no answer within `timeoutMs` are all false, so a stopped or stuck parser never holds the health answer
 * for longer than that.
 */
export function probeParser(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    const finish = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
