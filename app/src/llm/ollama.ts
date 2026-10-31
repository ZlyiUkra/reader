import type { ValidateFunction } from 'ajv/dist/2020.js';
import { createAjv } from '../config/ajv.ts';
import type { ModelConfig } from '../config/types.ts';
import { constants } from '../constants.ts';
import type { WireSchema } from '../registry/wire.ts';
import type { Logger } from '../shared/logger.ts';
import { LlmAdapterError } from './port.ts';
import type { LlmAdapter, LlmReadiness, LlmRequest, LlmResponse } from './port.ts';
import type { ModelSettings } from './settings.ts';

/**
 * The Ollama adapter (contracts/llm-port.md, research R5): one structured call to `/api/chat`, two fallbacks when the
 * structured reply is invalid, every reply validated against the wire schema whatever the server claims (FR-039), and
 * a readiness check that is true only for the pinned digest, after a warm-up, with the context the thresholds file
 * names (FR-037). The model has no tools, no database and no network of its own (constitution VIII): all it can do
 * here is return text, and the text is data until the schema accepts it.
 */
export type OllamaDeps = {
  /** Base URL of the model service, `MODEL_URL` (for example `http://model:11434`). */
  baseUrl: string;
  model: ModelConfig;
  settings: ModelSettings;
  logger: Logger;
};

/** Which fallback produced a reply; recorded in `raw.request` so a stored extraction says how it was obtained (C4). */
type Fallback = 'none' | 'generate' | 'think';

/** One request to the model service: the endpoint, which fallback it is and the body sent. */
type AttemptSpec = { endpoint: '/api/chat' | '/api/generate'; fallback: Fallback; body: object };

/** What one attempt gave: a reply to return (possibly cut off at the cap), or why it was not usable. */
type AttemptResult = { outcome: 'reply'; response: LlmResponse } | { outcome: 'invalid'; problem: string };

/** The schema of the warm-up call: the smallest structured reply that proves the model loaded and answers. */
const warmupSchema: WireSchema = {
  type: 'object',
  required: ['ok'],
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
};

/** Narrows a parsed JSON value to an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, or null: the server leaves counts and durations out when it did not measure them. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string, or null. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Brings a digest to the form the pin is kept in: 64 lower-case hex characters, without a `sha256:` prefix. */
function normalizeDigest(digest: unknown): string {
  return typeof digest === 'string' ? digest.toLowerCase().replace(/^sha256:/, '') : '';
}

/** Finds the entry of one model in the `models` list of `/api/tags` or `/api/ps`, by its name. */
function findModel(reply: unknown, tag: string): Record<string, unknown> | undefined {
  if (!isRecord(reply) || !Array.isArray(reply['models'])) {
    return undefined;
  }
  for (const entry of reply['models']) {
    if (isRecord(entry) && (entry['name'] === tag || entry['model'] === tag)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Reads a reply body up to the cap of `constants.maxModelReplyBytes` and no further, so a misbehaving server cannot fill
 * the memory of the app (AGENTS.md: nothing is read whole before its cap is checked).
 */
async function readBounded(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > constants.maxModelReplyBytes) {
      await reader.cancel();
      throw new LlmAdapterError('transport', `The model service sent more than ${constants.maxModelReplyBytes} bytes in one reply.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Creates the adapter. It holds no connection: each call is one HTTP request, so a restarted model service needs no reconnect. */
export function createOllamaAdapter(deps: OllamaDeps): LlmAdapter {
  const { model, settings, logger } = deps;
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const ajv = createAjv();
  const validators = new Map<string, ValidateFunction>();

  /** A signal that never fires, for the readiness checks, which have no caller to abort them; `request` adds the timeout. */
  const noSignal = new AbortController().signal;

  /**
   * Compiles the wire schema once per distinct schema. Ajv compiles slowly and caches by object identity, while the
   * registry hands out a new object per call, so the compiled function is kept by the schema's text.
   */
  function validatorFor(schema: WireSchema): ValidateFunction {
    const key = JSON.stringify(schema);
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = ajv.compile(schema);
      validators.set(key, validate);
    }
    return validate;
  }

  /**
   * One HTTP request to the model service with the client timeout of the thresholds file and the caller's signal. A
   * caller's abort is rethrown as it is; everything else becomes an `LlmAdapterError` that names the endpoint and carries
   * no body text, because a body can hold document text and logs must not (AGENTS.md).
   */
  async function request(method: 'GET' | 'POST', route: string, body: object | undefined, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(settings.clientTimeoutS * 1000);
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      });
      const text = await readBounded(response);
      if (!response.ok) {
        let detail = '';
        try {
          const parsed: unknown = JSON.parse(text);
          const message = isRecord(parsed) ? stringOrNull(parsed['error']) : null;
          detail = message === null ? '' : `: ${message.slice(0, 200)}`;
        } catch {
          // The error body is not JSON; the status alone is reported.
        }
        throw new LlmAdapterError('http', `The model service answered ${response.status} on ${route}${detail}.`);
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        throw new LlmAdapterError('invalid-reply', `The model service sent a body on ${route} that is not JSON.`);
      }
    } catch (error) {
      if (error instanceof LlmAdapterError) {
        throw error;
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      if (timeout.aborted) {
        throw new LlmAdapterError('timeout', `The model service did not answer ${route} within ${settings.clientTimeoutS} s.`);
      }
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
      throw new LlmAdapterError('transport', `The model service could not be reached on ${route}: ${cause}.`);
    }
  }

  /** The `/api/chat` body of a request; `think` is false on the first attempt and true on the last fallback (C4). */
  function chatBody(req: LlmRequest, think: boolean): object {
    return {
      model: model.tag,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      stream: false,
      think,
      format: req.wireSchema,
      keep_alive: settings.keepAlive,
      options: { num_predict: req.numPredict },
    };
  }

  /** The `/api/generate` body of fallback 1: the system text goes in `system` and the user text in `prompt`. */
  function generateBody(req: LlmRequest): object {
    return {
      model: model.tag,
      system: req.system,
      prompt: req.user,
      stream: false,
      think: false,
      format: req.wireSchema,
      keep_alive: settings.keepAlive,
      options: { num_predict: req.numPredict },
    };
  }

  /** The three attempts in order: chat without thinking, generate, then chat with thinking (C4). */
  function attemptsFor(req: LlmRequest): AttemptSpec[] {
    return [
      { endpoint: '/api/chat', fallback: 'none', body: chatBody(req, false) },
      { endpoint: '/api/generate', fallback: 'generate', body: generateBody(req) },
      { endpoint: '/api/chat', fallback: 'think', body: chatBody(req, true) },
    ];
  }

  /**
   * Turns one reply into a response or a reason it is unusable. A reply cut off at the generation cap is returned as it is
   * with `json` null and is never retried (FR-022); anything else must parse and satisfy the wire schema.
   */
  function interpret(reply: unknown, spec: AttemptSpec, wireSchema: WireSchema): AttemptResult {
    if (!isRecord(reply)) {
      return { outcome: 'invalid', problem: 'the reply is not a JSON object' };
    }
    const loadNs = numberOrNull(reply['load_duration']);
    const doneReason = stringOrNull(reply['done_reason']);
    const message = reply['message'];
    const content = spec.endpoint === '/api/chat' ? (isRecord(message) ? stringOrNull(message['content']) : null) : stringOrNull(reply['response']);
    const base = {
      raw: { request: { endpoint: spec.endpoint, fallback: spec.fallback, body: spec.body }, response: reply },
      modelName: stringOrNull(reply['model']) ?? model.tag,
      modelDigest: normalizeDigest(model.digest),
      doneReason,
      counts: { promptEval: numberOrNull(reply['prompt_eval_count']), eval: numberOrNull(reply['eval_count']) },
      durationsNs: {
        load: loadNs,
        promptEval: numberOrNull(reply['prompt_eval_duration']),
        eval: numberOrNull(reply['eval_duration']),
        total: numberOrNull(reply['total_duration']),
      },
      cold: loadNs !== null && loadNs > settings.coldLoadNs,
    };
    if (doneReason === 'length') {
      return { outcome: 'reply', response: { ...base, json: null } };
    }
    if (content === null || content.trim() === '') {
      return { outcome: 'invalid', problem: 'the reply has no content' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { outcome: 'invalid', problem: 'the content is not JSON' };
    }
    const validate = validatorFor(wireSchema);
    if (!validate(parsed)) {
      return { outcome: 'invalid', problem: `the content does not satisfy the wire schema (${ajv.errorsText(validate.errors)})` };
    }
    return { outcome: 'reply', response: { ...base, json: parsed } };
  }

  /** The state of the readiness check, kept between polls: `/api/health` asks every two seconds, a warm-up must not. */
  let readyDigest: string | null = null;
  let failedAt = 0;
  let inflight: Promise<LlmReadiness> | undefined;
  const noted = new Set<string>();

  /** Logs a readiness problem once until the model has been ready again, so a poll every two seconds does not flood the log. */
  function note(key: string, fields: object, message: string): void {
    if (!noted.has(key)) {
      noted.add(key);
      logger.warn(fields, message);
    }
  }

  /** The model runs with a context other than the thresholds file's: it is not ready, and both numbers go to the log (FR-037). */
  function contextMismatch(contextLength: number | null): LlmReadiness {
    note(
      'context',
      { contextLength, numCtx: settings.numCtx },
      `The model service runs the model with a context of ${contextLength ?? 'an unreported number of'} tokens but config/thresholds.json says ${settings.numCtx}; the model stays missing.`,
    );
    readyDigest = null;
    failedAt = Date.now();
    return { state: 'missing', digest: null };
  }

  /**
   * The readiness check of contracts/llm-port.md: the pinned digest is listed by `/api/tags`, one warm-up call returns
   * `done_reason: stop`, and `/api/ps` shows the context the thresholds file expects. The cheap listing runs on every
   * poll so a removed or replaced model is noticed at once; the warm-up and the context check run once and again only
   * after a failure and the pause of `constants.readinessRetryMs`.
   */
  async function evaluate(): Promise<LlmReadiness> {
    const missing: LlmReadiness = { state: 'missing', digest: null };
    const pinned = normalizeDigest(model.digest);
    if (pinned === '') {
      readyDigest = null;
      note('unpinned', { tag: model.tag }, 'The model digest is not pinned in config/model.json, so the model stays missing.');
      return missing;
    }
    let tags: unknown;
    try {
      tags = await request('GET', '/api/tags', undefined, noSignal);
    } catch {
      readyDigest = null;
      return missing;
    }
    const listed = findModel(tags, model.tag);
    if (listed === undefined) {
      readyDigest = null;
      note('absent', { tag: model.tag }, 'The model service does not list the configured model.');
      return missing;
    }
    if (normalizeDigest(listed['digest']) !== pinned) {
      readyDigest = null;
      note('digest', { tag: model.tag }, 'The model service lists the configured model with a digest that is not the pinned one.');
      return missing;
    }
    if (readyDigest === pinned) {
      // The model service may have been restarted with another context since the warm-up. A loaded model shows its context
      // in `/api/ps`; an unloaded one (after the keep-alive, or a restart) shows nothing and stays ready, because the next
      // call loads it and the next poll then sees the context it got.
      try {
        const running = findModel(await request('GET', '/api/ps', undefined, noSignal), model.tag);
        const loadedContext = running === undefined ? settings.numCtx : numberOrNull(running['context_length']);
        if (loadedContext !== settings.numCtx) {
          return contextMismatch(loadedContext);
        }
      } catch {
        readyDigest = null;
        return missing;
      }
      return { state: 'ready', digest: pinned };
    }
    if (Date.now() - failedAt < constants.readinessRetryMs) {
      return missing;
    }
    try {
      const warmup: LlmRequest = {
        kind: 'classify',
        documentNumber: 0,
        class: 'synthetic',
        system: 'Reply with JSON that matches the schema.',
        user: 'Set "ok" to true.',
        wireSchema: warmupSchema,
        numPredict: constants.warmupNumPredict,
      };
      const spec: AttemptSpec = { endpoint: '/api/chat', fallback: 'none', body: chatBody(warmup, false) };
      const result = interpret(await request('POST', spec.endpoint, spec.body, noSignal), spec, warmupSchema);
      if (result.outcome !== 'reply' || result.response.doneReason !== 'stop') {
        throw new LlmAdapterError('invalid-reply', 'The warm-up call did not return a complete valid reply.');
      }
      const running = findModel(await request('GET', '/api/ps', undefined, noSignal), model.tag);
      const contextLength = running === undefined ? null : numberOrNull(running['context_length']);
      if (contextLength !== settings.numCtx) {
        return contextMismatch(contextLength);
      }
    } catch (error) {
      failedAt = Date.now();
      note('warmup', { cause: error instanceof Error ? error.message : String(error) }, 'The warm-up of the model failed; the model stays missing.');
      return missing;
    }
    readyDigest = pinned;
    failedAt = 0;
    noted.clear();
    return { state: 'ready', digest: pinned };
  }

  return {
    name: 'ollama',
    local: true,

    readiness(): Promise<LlmReadiness> {
      inflight ??= evaluate().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },

    async call(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const problems: string[] = [];
      for (const spec of attemptsFor(req)) {
        const result = interpret(await request('POST', spec.endpoint, spec.body, signal), spec, req.wireSchema);
        if (result.outcome === 'reply') {
          if (problems.length > 0) {
            logger.warn({ documentNumber: req.documentNumber, kind: req.kind, fallback: spec.fallback, problems }, 'The model reply needed a fallback.');
          }
          return result.response;
        }
        problems.push(`${spec.fallback}: ${result.problem}`);
      }
      throw new LlmAdapterError('invalid-reply', 'The model gave no valid reply after the fallbacks.', problems);
    },
  };
}
