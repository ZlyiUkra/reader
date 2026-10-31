import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { test } from 'node:test';
import type { ClassesFile, ModelConfig } from '../src/config/types.ts';
import { createDispatcher } from '../src/llm/dispatcher.ts';
import { createOllamaAdapter } from '../src/llm/ollama.ts';
import { LlmAdapterError, LocalOnlyViolation, PromptOverBudget } from '../src/llm/port.ts';
import type { LlmAdapter, LlmRequest, LlmResponse } from '../src/llm/port.ts';
import { createReplayAdapter, recordingFile, ReplayRecordingMissing, requestKey } from '../src/llm/replay.ts';
import type { ModelSettings } from '../src/llm/settings.ts';
import { classifySchema } from '../src/registry/wire.ts';

/**
 * The LLM port without a GPU (T023, T024, T025; acceptance check 9): the dispatcher's three rules, the replay adapter,
 * and the Ollama adapter against a small HTTP server that plays the model service. The one thing these cannot show is what
 * the real model answers; that is the contract test (`ollama-contract.test.ts`).
 */

const settings: ModelSettings = {
  numCtx: 16384,
  numPredict: { classify: 64, extract: 1536 },
  clientTimeoutS: 5,
  keepAlive: '30m',
  charsPerToken: 3,
  coldLoadNs: 2_000_000_000,
};

const digest = 'a'.repeat(64);
const model: ModelConfig = { tag: 'qwen3.5:4b', digest };

const classes: ClassesFile = {
  version: 1,
  classes: [
    { name: 'synthetic', may_leave: false, description: 'test' },
    { name: 'open', may_leave: true, description: 'test' },
  ],
};

/** A logger that keeps what it was told. */
function recordingLogger(): { info: object[]; warn: Array<{ fields: object; message: string }>; logger: { info: (f: object, m: string) => void; warn: (f: object, m: string) => void } } {
  const info: object[] = [];
  const warn: Array<{ fields: object; message: string }> = [];
  return {
    info,
    warn,
    logger: {
      info: (fields) => void info.push(fields),
      warn: (fields, message) => void warn.push({ fields, message }),
    },
  };
}

const schema = classifySchema(['invoice', 'act']);

/** A request whose reply must satisfy `schema`. */
function request(user = 'Document text.', cls = 'synthetic'): LlmRequest {
  return { kind: 'classify', documentNumber: 7, class: cls, system: 'System.', user, wireSchema: schema, numPredict: 64 };
}

/** A response as an adapter returns it. */
function response(json: unknown): LlmResponse {
  return {
    json,
    raw: { request: {}, response: {} },
    modelName: model.tag,
    modelDigest: digest,
    doneReason: 'stop',
    counts: { promptEval: 1, eval: 1 },
    durationsNs: { load: 1, promptEval: 1, eval: 1, total: 3 },
    cold: false,
  };
}

/** An adapter that answers at once and counts what reached it. */
function stubAdapter(local: boolean): LlmAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name: 'stub',
    local,
    calls,
    async readiness() {
      return { state: 'ready', digest };
    },
    async call(req) {
      calls.push(req);
      return response({ type: 'invoice' });
    },
  };
}

// ---------------------------------------------------------------- dispatcher

test('the dispatcher sends a class that may not leave only to a local adapter and fails closed on an unknown class', async () => {
  const signal = new AbortController().signal;
  const remote = stubAdapter(false);
  const remoteDispatcher = createDispatcher({ adapter: remote, classes, settings, logger: recordingLogger().logger });
  await assert.rejects(remoteDispatcher.call(request('x', 'synthetic'), signal), LocalOnlyViolation);
  await assert.rejects(remoteDispatcher.call(request('x', 'not-a-class'), signal), LocalOnlyViolation);
  assert.equal(remote.calls.length, 0, 'nothing was sent');
  assert.deepEqual((await remoteDispatcher.call(request('x', 'open'), signal)).json, { type: 'invoice' });
  assert.equal(remote.calls.length, 1);

  const local = stubAdapter(true);
  const localDispatcher = createDispatcher({ adapter: local, classes, settings, logger: recordingLogger().logger });
  await localDispatcher.call(request('x', 'synthetic'), signal);
  assert.equal(local.calls.length, 1, 'a local adapter takes any class');
});

test('the dispatcher refuses a prompt that does not fit the context next to the generation cap, to the token', async () => {
  const signal = new AbortController().signal;
  const adapter = stubAdapter(true);
  const log = recordingLogger();
  const dispatcher = createDispatcher({ adapter, classes, settings, logger: log.logger });
  const req = (chars: number): LlmRequest => ({ ...request('x'), system: '', user: 'x'.repeat(chars), numPredict: 1536 });
  // 16384 - 1536 = 14848 tokens available; at 3 characters per token that is 44544 characters.
  await dispatcher.call(req(44544), signal);
  await assert.rejects(dispatcher.call(req(44545), signal), (error: unknown) => {
    assert.ok(error instanceof PromptOverBudget);
    assert.equal(error.estimatedTokens, 14849);
    assert.equal(error.availableTokens, 14848);
    assert.equal(error.numCtx, 16384);
    assert.equal(error.numPredict, 1536);
    return true;
  });
  assert.equal(adapter.calls.length, 1, 'the refused prompt was not sent');
  assert.equal(log.warn.length, 1);
});

test('the dispatcher runs one call at a time in arrival order, and a call aborted while it waits never starts', async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let running = 0;
  let maxRunning = 0;
  const adapter: LlmAdapter = {
    name: 'slow',
    local: true,
    async readiness() {
      return { state: 'ready', digest };
    },
    async call(req) {
      started.push(req.user);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return response({ type: 'invoice' });
    },
  };
  const dispatcher = createDispatcher({ adapter, classes, settings, logger: recordingLogger().logger });
  const never = new AbortController().signal;
  const first = dispatcher.call(request('first'), never);
  const second = dispatcher.call(request('second'), never);
  const abort = new AbortController();
  const third = dispatcher.call(request('third'), abort.signal);
  const fourth = dispatcher.call(request('fourth'), never);
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  await settle();
  assert.deepEqual(started, ['first']);
  abort.abort(new Error('worker stopped'));
  releases.shift()?.();
  await first;
  await settle();
  assert.deepEqual(started, ['first', 'second']);
  releases.shift()?.();
  await second;
  await assert.rejects(third, /worker stopped/);
  await settle();
  assert.deepEqual(started, ['first', 'second', 'fourth'], 'the aborted call was skipped');
  releases.shift()?.();
  await fourth;
  assert.equal(maxRunning, 1);
});

// -------------------------------------------------------------------- replay

test('the replay adapter serves a recording by the hash of the request and fails loudly on a missing or stale one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reader-replay-'));
  try {
    const signal = new AbortController().signal;
    const adapter = createReplayAdapter(dir);
    const req = request('Page one.');
    await assert.rejects(adapter.call(req, signal), (error: unknown) => {
      assert.ok(error instanceof ReplayRecordingMissing);
      assert.equal(error.key, requestKey(req));
      return true;
    });

    const recorded = response({ type: 'act' });
    await writeFile(recordingFile(dir, req), JSON.stringify(recorded));
    assert.deepEqual(await adapter.call(req, signal), recorded);
    assert.deepEqual(await adapter.readiness(), { state: 'ready', digest: null });
    assert.equal(adapter.local, true);

    // The key does not depend on the order of the schema's keys, and does depend on every text and number the model sees.
    const reordered = { ...req, wireSchema: Object.fromEntries(Object.entries(schema).reverse()) };
    assert.equal(requestKey(reordered), requestKey(req));
    assert.notEqual(requestKey({ ...req, user: 'Page two.' }), requestKey(req));
    assert.notEqual(requestKey({ ...req, numPredict: 65 }), requestKey(req));
    const otherDocument: LlmRequest = { ...req, documentNumber: 8, class: 'open' };
    assert.equal(requestKey(otherDocument), requestKey(req), 'identity of the document is not part of the key');

    const stale = request('Page three.');
    await writeFile(recordingFile(dir, stale), JSON.stringify(response({ type: 'receipt' })));
    await assert.rejects(adapter.call(stale, signal), (error: unknown) => error instanceof LlmAdapterError && error.kind === 'recording');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- ollama

type Scripted = { status?: number; body?: unknown; hang?: boolean };
type Seen = { method: string; url: string; body: unknown };

/** Collects the body of a request. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Plays the model service: every request is recorded and answered as `script` says. */
async function fakeOllama(script: (seen: Seen) => Scripted): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req);
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', body: text === '' ? undefined : JSON.parse(text) };
    seen.push(entry);
    const answer = script(entry);
    if (answer.hang === true) {
      return;
    }
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A reply of `/api/chat` the way Ollama sends it. */
function chatReply(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'qwen3.5:4b',
    message: { role: 'assistant', content, thinking: '' },
    done: true,
    done_reason: 'stop',
    total_duration: 5,
    load_duration: 1,
    prompt_eval_count: 11,
    prompt_eval_duration: 2,
    eval_count: 3,
    eval_duration: 4,
    ...extra,
  };
}

/** Runs `fn` against a fake model service and closes it afterwards. */
async function withModel(script: (seen: Seen) => Scripted, fn: (service: { url: string; seen: Seen[] }) => Promise<void>): Promise<void> {
  const service = await fakeOllama(script);
  try {
    await fn(service);
  } finally {
    await service.close();
  }
}

const valid = JSON.stringify({ type: 'invoice' });

test('the Ollama adapter sends the structured chat request of research R5 and maps the reply', async () => {
  await withModel(
    () => ({ body: chatReply(valid, { load_duration: 3_000_000_000 }) }),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      const result = await adapter.call(request('The page.'), new AbortController().signal);
      assert.equal(service.seen.length, 1);
      const sent = service.seen[0];
      assert.equal(sent?.method, 'POST');
      assert.equal(sent?.url, '/api/chat');
      assert.deepEqual(sent?.body, {
        model: 'qwen3.5:4b',
        messages: [
          { role: 'system', content: 'System.' },
          { role: 'user', content: 'The page.' },
        ],
        stream: false,
        think: false,
        format: schema,
        keep_alive: '30m',
        options: { num_predict: 64 },
      });
      assert.deepEqual(result.json, { type: 'invoice' });
      assert.equal(result.doneReason, 'stop');
      assert.equal(result.modelName, 'qwen3.5:4b');
      assert.equal(result.modelDigest, digest);
      assert.deepEqual(result.counts, { promptEval: 11, eval: 3 });
      assert.deepEqual(result.durationsNs, { load: 3_000_000_000, promptEval: 2, eval: 4, total: 5 });
      assert.equal(result.cold, true, 'a load above the threshold marks the call cold');
      assert.equal((result.raw.request as { fallback: string }).fallback, 'none');
    },
  );
  await withModel(
    () => ({ body: chatReply(valid) }),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: `${service.url}/`, model, settings, logger: recordingLogger().logger });
      assert.equal((await adapter.call(request(), new AbortController().signal)).cold, false);
    },
  );
});

test('an invalid structured reply falls back to /api/generate, then to thinking, and each is recorded', async () => {
  const log = recordingLogger();
  let step = 0;
  await withModel(
    () => {
      step += 1;
      if (step === 1) return { body: chatReply('') };
      if (step === 2) return { body: { model: 'qwen3.5:4b', response: 'not json', done: true, done_reason: 'stop' } };
      return { body: chatReply(valid) };
    },
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: log.logger });
      const result = await adapter.call(request('The page.'), new AbortController().signal);
      assert.deepEqual(
        service.seen.map((entry) => entry.url),
        ['/api/chat', '/api/generate', '/api/chat'],
      );
      assert.deepEqual(service.seen[1]?.body, {
        model: 'qwen3.5:4b',
        system: 'System.',
        prompt: 'The page.',
        stream: false,
        think: false,
        format: schema,
        keep_alive: '30m',
        options: { num_predict: 64 },
      });
      assert.equal((service.seen[2]?.body as { think: boolean }).think, true);
      assert.equal((result.raw.request as { fallback: string }).fallback, 'think');
      assert.equal(log.warn.length, 1);
    },
  );

  // The generate fallback reads `response`, not `message.content`.
  let calls = 0;
  await withModel(
    () => {
      calls += 1;
      return calls === 1 ? { body: chatReply('{"type": "unknown-type"}') } : { body: { model: 'qwen3.5:4b', response: valid, done: true, done_reason: 'stop' } };
    },
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      const result = await adapter.call(request(), new AbortController().signal);
      assert.equal(service.seen.length, 2);
      assert.deepEqual(result.json, { type: 'invoice' });
      assert.equal((result.raw.request as { fallback: string }).fallback, 'generate');
    },
  );
});

test('a reply that stays invalid after the fallbacks is an adapter error with one line per attempt and no content', async () => {
  await withModel(
    () => ({ body: chatReply('{"type": "receipt", "secret": "page text"}') }),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      await assert.rejects(adapter.call(request(), new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof LlmAdapterError);
        assert.equal(error.kind, 'invalid-reply');
        assert.equal(error.details.length, 3);
        assert.ok(!error.details.join('\n').includes('page text'), 'the reply content is not echoed');
        return true;
      });
      assert.equal(service.seen.length, 3);
    },
  );
});

test('a reply cut off at the generation cap is returned as it is, with no value and no retry', async () => {
  await withModel(
    () => ({ body: chatReply('{"type": "inv', { done_reason: 'length' }) }),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      const result = await adapter.call(request(), new AbortController().signal);
      assert.equal(result.doneReason, 'length');
      assert.equal(result.json, null);
      assert.equal(service.seen.length, 1);
    },
  );
});

test('an HTTP error, a silent server and a caller that gives up are told apart', async () => {
  await withModel(
    () => ({ status: 500, body: { error: 'model runner has unexpectedly stopped' } }),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      await assert.rejects(adapter.call(request(), new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof LlmAdapterError);
        assert.equal(error.kind, 'http');
        assert.match(error.message, /500/);
        return true;
      });
      assert.equal(service.seen.length, 1, 'an HTTP error is not a reason for a fallback');
    },
  );
  await withModel(
    () => ({ hang: true }),
    async (service) => {
      const quick: ModelSettings = { ...settings, clientTimeoutS: 0.2 };
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings: quick, logger: recordingLogger().logger });
      await assert.rejects(adapter.call(request(), new AbortController().signal), (error: unknown) => error instanceof LlmAdapterError && error.kind === 'timeout');
      const abort = new AbortController();
      const pending = adapter.call(request(), abort.signal);
      setTimeout(() => abort.abort(new Error('worker stopped')), 50);
      await assert.rejects(pending, /worker stopped/);
    },
  );
  const gone = await fakeOllama(() => ({}));
  const url = gone.url;
  await gone.close();
  const adapter = createOllamaAdapter({ baseUrl: url, model, settings, logger: recordingLogger().logger });
  await assert.rejects(adapter.call(request(), new AbortController().signal), (error: unknown) => error instanceof LlmAdapterError && error.kind === 'transport');
});

/** The routes of a healthy model service, with the digest and context the tests vary. */
function healthy(over: { digest?: string; name?: string; context?: number | null } = {}): (seen: Seen) => Scripted {
  return (seen) => {
    if (seen.url === '/api/tags') {
      return { body: { models: [{ name: over.name ?? 'qwen3.5:4b', digest: over.digest ?? digest }] } };
    }
    if (seen.url === '/api/ps') {
      return { body: { models: [{ name: 'qwen3.5:4b', context_length: over.context === undefined ? 16384 : over.context }] } };
    }
    return { body: chatReply('{"ok": true}') };
  };
}

test('readiness is true only for the pinned digest, after one warm-up, with the configured context, and the warm-up is not repeated', async () => {
  const log = recordingLogger();
  await withModel(healthy({ digest: `SHA256:${digest.toUpperCase()}` }), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: log.logger });
    assert.deepEqual(await adapter.readiness(), { state: 'ready', digest });
    assert.deepEqual(await adapter.readiness(), { state: 'ready', digest });
    const chats = service.seen.filter((entry) => entry.url === '/api/chat');
    assert.equal(chats.length, 1, 'one warm-up for two polls');
    assert.deepEqual((chats[0]?.body as { options: object }).options, { num_predict: 16 });
    assert.equal(service.seen.filter((entry) => entry.url === '/api/tags').length, 2, 'the listing is checked on every poll');
    assert.equal(service.seen.filter((entry) => entry.url === '/api/ps').length, 2, 'and so is the loaded context');
    assert.equal(log.warn.length, 0);
  });
});

test('readiness stays missing without a pin, with another digest, without the model, with a wrong context or without a server', async () => {
  const unpinned = recordingLogger();
  await withModel(healthy(), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model: { tag: 'qwen3.5:4b', digest: '' }, settings, logger: unpinned.logger });
    assert.deepEqual(await adapter.readiness(), { state: 'missing', digest: null });
    await adapter.readiness();
    assert.equal(service.seen.length, 0, 'with no pin nothing is asked');
    assert.equal(unpinned.warn.length, 1, 'and the log says so once');
  });

  await withModel(healthy({ digest: 'b'.repeat(64) }), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
    assert.equal((await adapter.readiness()).state, 'missing');
    assert.equal(service.seen.filter((entry) => entry.url === '/api/chat').length, 0, 'no warm-up for a model that is not the pinned one');
  });

  await withModel(healthy({ name: 'other:1b' }), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
    assert.equal((await adapter.readiness()).state, 'missing');
  });

  const mismatch = recordingLogger();
  await withModel(healthy({ context: 4096 }), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: mismatch.logger });
    assert.deepEqual(await adapter.readiness(), { state: 'missing', digest: null });
    assert.equal(mismatch.warn.length, 1);
    assert.match(mismatch.warn[0]?.message ?? '', /4096/);
    assert.match(mismatch.warn[0]?.message ?? '', /16384/);
    assert.deepEqual(mismatch.warn[0]?.fields, { contextLength: 4096, numCtx: 16384 });
    await adapter.readiness();
    assert.equal(service.seen.filter((entry) => entry.url === '/api/chat').length, 1, 'a failed check is not repeated at once');
    assert.equal(mismatch.warn.length, 1);
  });

  await withModel(healthy({ context: null }), async (service) => {
    const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
    assert.equal((await adapter.readiness()).state, 'missing', 'a server that does not report the context is not trusted');
  });

  const down = await fakeOllama(() => ({}));
  const url = down.url;
  await down.close();
  const adapter = createOllamaAdapter({ baseUrl: url, model, settings, logger: recordingLogger().logger });
  assert.deepEqual(await adapter.readiness(), { state: 'missing', digest: null });
});

test('a ready model whose service was restarted with another context goes missing, and an unloaded model stays ready', async () => {
  let context: number | null = 16384;
  let loaded = true;
  const log = recordingLogger();
  await withModel(
    (seen) => {
      if (seen.url === '/api/ps') {
        return { body: { models: loaded ? [{ name: 'qwen3.5:4b', context_length: context }] : [] } };
      }
      return healthy()(seen);
    },
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: log.logger });
      assert.equal((await adapter.readiness()).state, 'ready');
      loaded = false;
      assert.equal((await adapter.readiness()).state, 'ready', 'nothing loaded: the next call will load it');
      loaded = true;
      context = 4096;
      assert.deepEqual(await adapter.readiness(), { state: 'missing', digest: null });
      assert.equal(log.warn.length, 1);
      assert.match(log.warn[0]?.message ?? '', /4096/);
    },
  );
});

test('a model that was ready goes missing as soon as the listing shows another digest, and needs a new warm-up to return', async () => {
  let listed = digest;
  await withModel(
    (seen) => (seen.url === '/api/tags' ? { body: { models: [{ name: 'qwen3.5:4b', digest: listed }] } } : healthy()(seen)),
    async (service) => {
      const adapter = createOllamaAdapter({ baseUrl: service.url, model, settings, logger: recordingLogger().logger });
      assert.equal((await adapter.readiness()).state, 'ready');
      listed = 'c'.repeat(64);
      assert.equal((await adapter.readiness()).state, 'missing');
      listed = digest;
      assert.equal((await adapter.readiness()).state, 'ready');
      assert.equal(service.seen.filter((entry) => entry.url === '/api/chat').length, 2);
    },
  );
});
