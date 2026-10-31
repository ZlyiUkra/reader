import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { lstat, readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path/posix';
import { loadLimits } from './parse.ts';
import type { Limits, ParseOutcome } from './parse.ts';

/**
 * The parser service (C8, C9, contracts/parser.md): a long-lived process that answers `POST /parse {jobId}` on a Unix
 * socket in the shared jobs volume and runs every job as a fresh child process, one at a time. The service itself never
 * opens a document; it validates the request, starts `parse.ts` in its own process group with its own scratch folder,
 * waits under a deadline, and cleans up what the job may have left behind. It has no network and no dependencies, and
 * besides the jobs it reads one file, the thresholds file, once at start from a read-only mount.
 */

/** Where the socket, the jobs, the scratch folders and the thresholds are; the defaults are the container's, tests point them elsewhere. */
const socketPath = process.env['PARSER_SOCKET'] ?? '/jobs/parser.sock';
const jobsDir = process.env['PARSER_JOBS_DIR'] ?? '/jobs';
const workRoot = process.env['PARSER_WORK_DIR'] ?? '/tmp';
const thresholdsFile = path.join(process.env['PARSER_CONFIG_DIR'] ?? '/config', 'thresholds.json');

/**
 * True inside the sandbox container (the image sets it): there the parser's uid is its own and every other process with
 * that uid after a job is a leftover. Outside the container the uid is a person's, so the sweep is not made.
 */
const insideSandbox = process.env['PARSER_SANDBOX'] === '1';

/** The most a request body may be: `{jobId}` is under a hundred bytes. */
const maxBodyBytes = 8192;

/** The most output of a job's child that is kept: one JSON line, so a runaway child cannot fill memory. */
const maxChildOutputBytes = 65_536;

/** The answer the app gets: the child's outcome, or an internal error when the child did not end as designed. */
type Answer = ParseOutcome | { ok: false; code: 'INTERNAL_ERROR'; params: { cause: string } };

/** The reason codes the child may report; anything else it prints is not an outcome. */
const childCodes = new Set(['TOO_LARGE', 'CORRUPT', 'ENCRYPTED', 'UNSUPPORTED_FORMAT']);

/** True for an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a request body up to `maxBodyBytes`; resolves with null when it is longer. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length;
    if (bytes > maxBodyBytes) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sends a JSON answer. */
function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/**
 * The longest a whole job may take: the conversion, plus for every page its two renders and its OCR, plus slack. Each tool
 * has its own, shorter limit; this is the net under them, for a child that hangs between tools.
 */
function jobDeadlineMs(limits: Limits): number {
  return (limits.convertTimeoutS + limits.pageCap * (2 * limits.renderTimeoutSPerPage + limits.ocrTimeoutSPerPage) + 30) * 1000;
}

/** Turns what the child printed into an answer: one JSON line holding a known outcome, or an internal error. */
function answerOf(stdout: string, code: number | null, stderr: string): Answer {
  if (code !== 0) {
    console.error(`job child ended with exit code ${code}: ${stderr.trim().slice(-600)}`);
    return { ok: false, code: 'INTERNAL_ERROR', params: { cause: 'child_exit' } };
  }
  try {
    const outcome = JSON.parse(stdout.trim().split('\n').pop() ?? '') as unknown;
    if (isRecord(outcome) && outcome['ok'] === true) {
      return { ok: true };
    }
    if (isRecord(outcome) && outcome['ok'] === false && typeof outcome['code'] === 'string' && childCodes.has(outcome['code']) && isRecord(outcome['params'])) {
      return outcome as Answer;
    }
  } catch {
    // Not JSON: reported below as an output the service does not understand.
  }
  return { ok: false, code: 'INTERNAL_ERROR', params: { cause: 'child_output' } };
}

/**
 * Runs `parse.ts` as a fresh child for one job: its own process group, a request on standard input, a deadline that kills
 * the whole group. It never rejects; whatever goes wrong is an `INTERNAL_ERROR` answer.
 */
function runChild(jobId: string, limits: Limits): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'parse.ts')], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp', LANG: 'C.UTF-8', PARSER_JOBS_DIR: jobsDir, PARSER_WORK_DIR: workRoot },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killGroup = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group has already ended.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, jobDeadlineMs(limits));
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxChildOutputBytes) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      console.error(`job child could not start: ${error.message}`);
      resolve({ ok: false, code: 'INTERNAL_ERROR', params: { cause: 'child_start' } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      killGroup();
      resolve(timedOut ? { ok: false, code: 'INTERNAL_ERROR', params: { cause: 'job_deadline' } } : answerOf(stdout, code, stderr));
    });
    child.stdin.on('error', () => {
      // The child ended before reading its request; the close event reports how.
    });
    child.stdin.end(JSON.stringify({ jobId, limits }));
  });
}

/**
 * The pids of processes with this process's uid, other than this process, the container's init (it runs as the container's
 * user too, and a process cannot kill pid 1 of its namespace) and zombies, which init reaps.
 */
async function otherProcessesOfUid(): Promise<number[]> {
  const uid = process.getuid?.();
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid || Number(entry) === 1) {
      continue;
    }
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (owner !== undefined && Number(owner) === uid && !/^State:\s+Z/m.test(status)) {
        pids.push(Number(entry));
      }
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return pids;
}

/**
 * Kills what a finished job left running and returns how many processes of the uid survive the kill (contracts/parser.md:
 * leftovers of the parser's uid are killed after the job and the service exits if any survive). Only inside the sandbox.
 */
async function reapLeftovers(): Promise<number> {
  if (!insideSandbox) {
    return 0;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const leftovers = await otherProcessesOfUid();
    if (leftovers.length === 0) {
      return 0;
    }
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (await otherProcessesOfUid()).length;
}

/** True when `target` is a regular file or a directory, by `lstat`, so a symlink in its place does not count. */
async function isEntry(target: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const info = await lstat(target);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

/** One job at a time: true while a job is running, so a second request is answered 429. */
let busy = false;

/**
 * Handles `POST /parse`: validates the body, refuses with 429 while a job runs, checks that the app has put the original
 * and the output folder in place, runs the job with the limits read at start and answers `{jobId, ok}` or `{jobId, ok:
 * false, code, params}`. After the job the scratch folder is removed and leftover processes are killed; if any survive
 * the service exits, and the container's restart policy brings it back clean.
 */
async function handleParse(request: IncomingMessage, response: ServerResponse, limits: Limits): Promise<void> {
  const body = await readBody(request);
  if (body === null) {
    send(response, 413, { error: 'request too large' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    send(response, 400, { error: 'body is not JSON' });
    return;
  }
  const jobId = isRecord(parsed) && Object.keys(parsed).length === 1 ? parsed['jobId'] : undefined;
  if (typeof jobId !== 'string' || !/^[a-z0-9]{32}$/.test(jobId)) {
    send(response, 400, { error: 'body must be {jobId} with a 32 character job id' });
    return;
  }
  if (busy) {
    send(response, 429, { error: 'a job is running' }, { 'Retry-After': '1' });
    return;
  }
  busy = true;
  const started = performance.now();
  let survivors = 0;
  try {
    let answer: Answer;
    if (!(await isEntry(path.join(jobsDir, 'in', jobId, 'input'), 'file')) || !(await isEntry(path.join(jobsDir, 'out', jobId), 'directory'))) {
      answer = { ok: false, code: 'INTERNAL_ERROR', params: { cause: 'job_folders_missing' } };
    } else {
      answer = await runChild(jobId, limits);
      await rm(path.join(workRoot, jobId), { recursive: true, force: true });
      survivors = await reapLeftovers();
    }
    console.log(JSON.stringify({ jobId, ok: answer.ok, code: answer.ok ? null : answer.code, ms: Math.round(performance.now() - started), survivors }));
    send(response, 200, { jobId, ...answer });
  } finally {
    busy = false;
  }
  if (survivors > 0) {
    console.error(`${survivors} processes survived the sweep after job ${jobId}; exiting so the container restarts clean`);
    process.exit(1);
  }
}

/** The one route: `POST /parse`; any other path or method is refused. Every job runs to the limits given here. */
function createParserServer(limits: Limits): Server {
  return createServer((request, response) => {
    if (request.url !== '/parse') {
      send(response, 404, { error: 'not found' });
      return;
    }
    if (request.method !== 'POST') {
      send(response, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      return;
    }
    handleParse(request, response, limits).catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      if (!response.headersSent) {
        send(response, 500, { error: 'internal error' });
      }
    });
  });
}

/**
 * Reads the limits, then starts listening; a thresholds file the service cannot use stops it here, before any socket
 * exists. A stale socket from a previous run is unlinked first (the only file this service ever removes that it did not
 * make for the job); the socket is created with mode 0660, group 10001, because the default 0755 would refuse the app's
 * `connect` with `EACCES` (the app is in the socket's group and `connect` needs write permission).
 */
async function main(): Promise<void> {
  const server = createParserServer(await loadLimits(thresholdsFile));
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const previousMask = process.umask(0o117);
  server.listen(socketPath, () => {
    process.umask(previousMask);
    console.log(JSON.stringify({ listening: socketPath, uid: process.getuid?.() ?? null, thresholds: thresholdsFile }));
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
