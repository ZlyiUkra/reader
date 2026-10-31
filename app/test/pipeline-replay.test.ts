import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, beforeEach, test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { fieldsOfExtraction, latestExtractionOf, reasonsOf, stepRunsOf } from '../src/db/queries.ts';
import { LlmAdapterError } from '../src/llm/port.ts';
import type { LlmAdapter, LlmRequest, LlmResponse } from '../src/llm/port.ts';
import { modelSettings } from '../src/llm/settings.ts';
import type { ModelSettings } from '../src/llm/settings.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { endOpenDocuments, stateOf, testDatabase } from './support/db.ts';
import { addParsedFixture, fixtureExpectations, fixtureReplay, outcomeOf, replayDir, sameOutcome, startPipeline, waitForTerminal } from './support/pipeline-harness.ts';

/**
 * The model steps end to end on the replay adapter (T052, FR-050, acceptance check 9): the eleven fixtures, as the golden
 * parser outputs left them, go through classify, extract and check against the real PostgreSQL with the recorded replies of
 * the real model, and each ends in the status the generator expects. The same worker and the same dispatcher as in
 * production run here; only the adapter differs. The failure paths use small adapters of their own: three invalid replies
 * end a document FAILED, a reply that stopped at the generation cap ends one REJECTED after a single attempt.
 */
const database = await testDatabase();
const pool = database.pool;
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const settings = modelSettings(config.thresholds);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

after(() => database.close());
beforeEach(() => endOpenDocuments(pool));

/** Runs the pipeline over the given adapter until every document is terminal, then stops the worker. */
async function runUntilTerminal(adapter: LlmAdapter, ids: number[]): Promise<void> {
  const worker = startPipeline({ pool, adapter, classes: config.classes, registry, thresholds: config.thresholds, settings, logger: quiet });
  try {
    await waitForTerminal(pool, ids, 60_000);
  } finally {
    await worker.stop();
  }
}

/** An adapter that answers every call with the given function. */
function scripted(name: string, answer: (req: LlmRequest, call: number) => Promise<LlmResponse>): LlmAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name,
    local: true,
    calls,
    readiness: async () => ({ state: 'ready', digest: null }),
    call: async (req) => {
      calls.push(req);
      return answer(req, calls.length);
    },
  };
}

/** A well-formed response around a JSON value, for the adapters that script a reply. */
function response(json: unknown, doneReason: string): LlmResponse {
  return {
    json,
    raw: { request: { endpoint: '/api/chat', fallback: 'none', body: {} }, response: { message: { content: JSON.stringify(json) }, done_reason: doneReason } },
    modelName: 'scripted',
    modelDigest: 'a'.repeat(64),
    doneReason,
    counts: { promptEval: 10, eval: doneReason === 'length' ? settings.numPredict.classify : 3 },
    durationsNs: { load: null, promptEval: null, eval: null, total: null },
    cold: false,
  };
}

test('the recordings folder has a recording for every request of the eleven fixtures', async () => {
  const files = (await readdir(replayDir)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 2 * fixtureExpectations.length - 1, 'one classify and one extract per typed fixture, one classify for the untyped one');
});

test('each of the eleven fixtures reaches the status the generator expects, with the reasons it expects', async () => {
  const ids = new Map<string, number>();
  for (const expected of fixtureExpectations) {
    ids.set(expected.file, await addParsedFixture(pool, expected.file));
  }
  await runUntilTerminal(fixtureReplay(), [...ids.values()]);

  const got: Array<{ file: string; status: string; codes: string[] }> = [];
  for (const expected of fixtureExpectations) {
    const outcome = await outcomeOf(pool, ids.get(expected.file) ?? 0);
    got.push({ file: expected.file, status: outcome.status, codes: [...new Set(outcome.codes)] });
    assert.ok(sameOutcome(expected, outcome), `${expected.file}: expected ${expected.status} ${expected.codes.join(',')}, got ${outcome.status} ${outcome.codes.join(',')}`);
  }
  const accepted = got.filter((entry) => entry.status === 'ACCEPTED').length;
  assert.equal(accepted, 6, 'six ACCEPTED, three NEEDS_REVIEW for a missing required field, the wrong-VAT invoice and the untyped document');
  const missing = got.filter((entry) => entry.status === 'NEEDS_REVIEW' && entry.codes.includes('MISSING_REQUIRED_FIELD')).length;
  assert.equal(missing, 3, 'three documents miss a required field');
});

test('an accepted document carries its fields with evidence, the accepted extraction and checks done', async () => {
  const id = await addParsedFixture(pool, 'invoice-1.pdf');
  await runUntilTerminal(fixtureReplay(), [id]);
  const state = await pool.query<{ status: string; checks_done: boolean; accepted_extraction_id: number | null; doc_type: string | null; schema_id: string | null; attempts: number }>(
    'SELECT status, checks_done, accepted_extraction_id, doc_type, schema_id, attempts FROM documents WHERE id = $1',
    [id],
  );
  const row = state.rows[0];
  assert.equal(row?.status, 'ACCEPTED');
  assert.equal(row?.checks_done, true);
  assert.equal(row?.doc_type, 'invoice');
  assert.equal(row?.schema_id, 'https://reader.local/schemas/invoice.v1.json');
  assert.equal(row?.attempts, 1, 'the attempts of the last step: every step starts counting again');

  const extraction = await latestExtractionOf(pool, id, 'extract');
  assert.equal(row?.accepted_extraction_id, extraction?.id);
  const fields = await fieldsOfExtraction(pool, extraction?.id ?? 0);
  const required = registry.byName.get('invoice')?.fields.filter((field) => field.required).map((field) => field.name) ?? [];
  assert.deepEqual(fields.map((field) => field.name), registry.byName.get('invoice')?.fields.map((field) => field.name), 'a row for every field of the type, in registry order');
  for (const name of required) {
    const field = fields.find((candidate) => candidate.name === name);
    assert.equal(field?.found, true, `${name} is found`);
    assert.notEqual(field?.page_text_id, null, name);
    assert.ok((field?.offset_end ?? 0) > (field?.offset_start ?? 0), name);
    assert.equal(field?.source, 'model');
  }
  assert.deepEqual(await reasonsOf(pool, id), []);
  const runs = await stepRunsOf(pool, id);
  assert.deepEqual(runs.map((run) => [run.step, run.attempt, run.outcome]), [['classify', 1, 'ok'], ['extract', 1, 'ok'], ['check', 1, 'ok']]);
  const model = await pool.query<{ adapter: string; prompt_hash: string; registry_hash: string; wire_schema_hash: string; thresholds: Record<string, unknown> }>(
    'SELECT adapter, prompt_hash, registry_hash, wire_schema_hash, thresholds FROM extractions WHERE document_id = $1 ORDER BY id',
    [id],
  );
  assert.deepEqual(model.rows.map((entry) => entry.adapter), ['replay', 'replay']);
  assert.equal(model.rows[0]?.registry_hash, registry.hash);
  assert.match(model.rows[1]?.wire_schema_hash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(model.rows[1]?.thresholds['model.num_ctx'], settings.numCtx, 'the numbers in force are stored with the call');
});

test('the untyped document ends NEEDS_REVIEW with UNKNOWN_DOC_TYPE and no field rows', async () => {
  const id = await addParsedFixture(pool, 'letter-untyped.docx');
  await runUntilTerminal(fixtureReplay(), [id]);
  assert.deepEqual(await outcomeOf(pool, id), { status: 'NEEDS_REVIEW', codes: ['UNKNOWN_DOC_TYPE'] });
  const count = await pool.query<{ count: number }>('SELECT count(*) AS count FROM fields WHERE document_id = $1', [id]);
  assert.equal(count.rows[0]?.count, 0);
  assert.equal((await pool.query('SELECT doc_type FROM documents WHERE id = $1', [id])).rows[0].doc_type, null);
});

test('three invalid replies end a document FAILED, the first two leave it at its step', async () => {
  const id = await addParsedFixture(pool, 'invoice-1.pdf');
  const broken = scripted('scripted', async () => {
    throw new LlmAdapterError('invalid-reply', 'The model gave no valid reply after the fallbacks.', ['none: the content is not JSON']);
  });
  await runUntilTerminal(broken, [id]);
  const state = await stateOf(pool, id);
  assert.deepEqual({ status: state.status, attempts: state.attempts }, { status: 'FAILED', attempts: 3 });
  assert.equal(broken.calls.length, 3);
  assert.deepEqual((await reasonsOf(pool, id)).map((reason) => [reason.code, reason.params['cause'], reason.attempt]), [
    ['INTERNAL_ERROR', 'model_invalid_reply', 1],
    ['INTERNAL_ERROR', 'model_invalid_reply', 2],
    ['INTERNAL_ERROR', 'model_invalid_reply', 3],
  ]);
  assert.deepEqual((await stepRunsOf(pool, id)).map((run) => run.outcome), ['internal_error', 'internal_error', 'internal_error']);
});

test('a reply that stopped at the generation cap ends the document REJECTED TOO_LARGE after one attempt', async () => {
  const id = await addParsedFixture(pool, 'invoice-1.pdf');
  const cut = scripted('scripted', async () => response(null, 'length'));
  await runUntilTerminal(cut, [id]);
  const state = await stateOf(pool, id);
  assert.deepEqual({ status: state.status, attempts: state.attempts }, { status: 'REJECTED', attempts: 1 });
  assert.equal(cut.calls.length, 1, 'no retry');
  assert.deepEqual((await reasonsOf(pool, id)).map((reason) => [reason.code, reason.params]), [
    ['TOO_LARGE', { limit: 'num_predict', actual: settings.numPredict.classify, max: settings.numPredict.classify }],
  ]);
  const stored = await latestExtractionOf(pool, id, 'classify');
  assert.equal(stored?.done_reason, 'length', 'the call that was cut is stored as it was');
});

test('a prompt over the context budget ends the document REJECTED TOO_LARGE without a call', async () => {
  const id = await addParsedFixture(pool, 'invoice-1.pdf');
  const tiny: ModelSettings = { ...settings, numCtx: 400 };
  const never = scripted('scripted', async () => {
    throw new Error('the model must not be called');
  });
  const worker = startPipeline({ pool, adapter: never, classes: config.classes, registry, thresholds: config.thresholds, settings: tiny, logger: quiet });
  try {
    await waitForTerminal(pool, [id], 60_000);
  } finally {
    await worker.stop();
  }
  assert.equal(never.calls.length, 0);
  const reasons = await reasonsOf(pool, id);
  assert.deepEqual(reasons.map((reason) => [reason.code, reason.params['limit']]), [['TOO_LARGE', 'prompt_tokens']]);
  assert.equal((await stateOf(pool, id)).status, 'REJECTED');
  assert.ok(Number(reasons[0]?.params['actual']) > Number(reasons[0]?.params['max']));
});

test('a class that may not leave is never sent to a non-local adapter', async () => {
  const id = await addParsedFixture(pool, 'invoice-1.pdf');
  const remote: LlmAdapter & { calls: LlmRequest[] } = { ...scripted('remote', async () => response({ type: 'none' }, 'stop')), local: false };
  const worker = startPipeline({ pool, adapter: remote, classes: config.classes, registry, thresholds: config.thresholds, settings, logger: quiet });
  try {
    await waitForTerminal(pool, [id], 60_000);
  } finally {
    await worker.stop();
  }
  assert.equal(remote.calls.length, 0, 'the dispatcher refused before the adapter saw it');
  assert.equal((await stateOf(pool, id)).status, 'FAILED');
  assert.ok((await reasonsOf(pool, id)).every((reason) => reason.params['cause'] === 'local_only'));
});
