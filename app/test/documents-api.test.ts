import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { countDocuments } from '../src/db/queries.ts';
import { pageBlobKey } from '../src/intake/store.ts';
import { modelSettings } from '../src/llm/settings.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { buildServer } from '../src/server.ts';
import { endOpenDocuments, stateOf, testDatabase } from './support/db.ts';
import { addParsedFixture, fixtureReplay, goldenOf, startPipeline, waitForTerminal } from './support/pipeline-harness.ts';

/**
 * The document routes against the real PostgreSQL (T049, T054, T055, T056, FR-053, FR-053a, FR-054): three fixtures go
 * through classify, extract and check on the replay adapter, and the list, the detail view, the raw calls and the page
 * previews are read back through the server. What matters is what the routes leave out as much as what they carry: the
 * list and the detail never hold a page text or a model request, the raw route holds them for one document, and there is no
 * route that serves an original.
 */
const database = await testDatabase();
const pool = database.pool;
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

const blobRoot = await mkdtemp(path.join(tmpdir(), 'documents-api-'));
const app: FastifyInstance = await buildServer({
  logger: false,
  publicPort: 3000,
  webRoot: null,
  registry,
  reasons: createReasons(config.reasons),
  pageSize: 20,
  pageSizes: [10, 20, 50, 100],
  sandbox: 'runc',
  checkDb: async () => true,
  readiness: async () => ({ state: 'missing', digest: null }),
  intake: { pool, inboxDir: blobRoot, blobRoot, maxBytes: 1000, classes: config.classes, logger: { info: () => undefined, warn: () => undefined } },
});
const headers = { host: '127.0.0.1:3000' };

/** The numbers of the three documents, by what they are: an accepted one, one with a missing field, one of no type. */
let accepted = 0;
let missing = 0;
let untyped = 0;
/** The first words of the text of the accepted document's first page, which must never appear in a list or a detail answer. */
let pageTextSample = '';

before(async () => {
  await endOpenDocuments(pool);
  accepted = await addParsedFixture(pool, 'invoice-1.pdf');
  missing = await addParsedFixture(pool, 'act-3.rtf');
  untyped = await addParsedFixture(pool, 'letter-untyped.docx');
  const worker = startPipeline({ pool, adapter: fixtureReplay(), classes: config.classes, registry, thresholds: config.thresholds, settings: modelSettings(config.thresholds), logger: quiet });
  try {
    await waitForTerminal(pool, [accepted, missing, untyped], 60_000);
  } finally {
    await worker.stop();
  }
  pageTextSample = (await goldenOf('invoice-1.pdf')).texts[0]?.trim().slice(0, 24) ?? '';
  assert.ok(pageTextSample.length > 10, 'the sample of page text is long enough to be searched for');
});
after(async () => {
  await app.close();
  await database.close();
});

test('the list is newest first, carries reasons as codes and params, and never a page text or a model request', async () => {
  const response = await app.inject({ url: '/api/documents', headers });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  const numbers = body.documents.map((row: { number: number }) => row.number);
  assert.deepEqual(numbers, [...numbers].sort((a: number, b: number) => b - a));
  assert.equal(body.count, await countDocuments(pool), 'count is the number of documents, not of rows');
  const row = body.documents.find((candidate: { number: number }) => candidate.number === missing);
  assert.deepEqual(Object.keys(row).sort(), ['attempts', 'class', 'createdAt', 'number', 'originalName', 'reasons', 'sha256', 'status', 'type', 'updatedAt']);
  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.equal(row.type, 'act');
  assert.deepEqual(
    row.reasons.map((reason: { code: string }) => reason.code),
    ['MISSING_REQUIRED_FIELD'],
  );
  assert.equal(typeof row.reasons[0].params.field, 'string');
  const text = response.body;
  assert.ok(!text.includes(pageTextSample), 'no page text in the list');
  assert.ok(!/rawRequest|rawResponse|raw_request|verbatim/.test(text), 'no model data in the list');
});

test('the list takes a limit between 1 and 1000 and refuses others', async () => {
  const one = (await app.inject({ url: '/api/documents?limit=1', headers })).json();
  assert.equal(one.documents.length, 1);
  assert.ok(one.count >= 3, 'count still tells how many documents there are');
  for (const bad of ['0', '1001', 'many']) {
    assert.equal((await app.inject({ url: `/api/documents?limit=${bad}`, headers })).statusCode, 400, bad);
  }
});

test('a page of the list is cut by limit and offset, and the answer echoes both with the total', async () => {
  const all = (await app.inject({ url: '/api/documents?limit=1000', headers })).json();
  assert.ok(all.count >= 3);
  assert.deepEqual({ limit: all.limit, offset: all.offset }, { limit: 1000, offset: 0 });
  const numbers: number[] = all.documents.map((row: { number: number }) => row.number);
  const second = (await app.inject({ url: '/api/documents?limit=2&offset=1', headers })).json();
  assert.deepEqual({ limit: second.limit, offset: second.offset, count: second.count }, { limit: 2, offset: 1, count: all.count });
  assert.deepEqual(second.documents.map((row: { number: number }) => row.number), numbers.slice(1, 3), 'the same rows as the full list, from the second');
  const reasonsOfPage = second.documents.flatMap((row: { reasons: unknown[] }) => row.reasons);
  assert.ok(Array.isArray(reasonsOfPage), 'a page carries the reasons of its own rows');
  const past = (await app.inject({ url: `/api/documents?limit=5&offset=${all.count + 10}`, headers })).json();
  assert.deepEqual({ documents: past.documents, count: past.count, offset: past.offset }, { documents: [], count: all.count, offset: all.count + 10 });
  assert.equal((await app.inject({ url: '/api/documents?offset=-1', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/documents?offset=x', headers })).statusCode, 400);
});

test('the detail of an accepted document holds every field with its fragment, page and offsets, and the steps and the model', async () => {
  const response = await app.inject({ url: `/api/documents/${accepted}`, headers });
  assert.equal(response.statusCode, 200);
  const detail = response.json();
  assert.equal(detail.status, 'ACCEPTED');
  assert.equal(detail.type, 'invoice');
  assert.deepEqual(detail.reasons, []);
  assert.ok(detail.fields.length > 0);
  const fieldsFound = detail.fields.filter((field: { found: boolean }) => field.found);
  assert.ok(fieldsFound.length > 0);
  for (const field of fieldsFound) {
    assert.equal(typeof field.verbatim, 'string', `${field.name} shows its fragment`);
    assert.ok(Number.isInteger(field.page) && field.page >= 1, `${field.name} shows its page`);
    assert.ok(Number.isInteger(field.offsetStart) && field.offsetEnd > field.offsetStart, `${field.name} has offsets`);
  }
  assert.deepEqual(detail.steps.map((step: { step: string }) => step.step), ['classify', 'extract', 'check']);
  for (const step of detail.steps) {
    assert.equal(step.outcome, 'ok');
    assert.ok(Number.isInteger(step.durationMs) && step.durationMs >= 0);
  }
  assert.equal(detail.pages.length, (await goldenOf('invoice-1.pdf')).manifest.pages.length);
  assert.deepEqual(Object.keys(detail.pages[0]).sort(), ['height', 'page', 'source', 'width']);
  assert.equal(detail.model.name.length > 0, true);
  assert.match(detail.model.promptHash, /^[0-9a-f]{64}$/);
  assert.equal(detail.model.schemaId, detail.schemaId);
  assert.ok(!response.body.includes(pageTextSample), 'no page text in the detail');
  assert.ok(!/rawRequest|rawResponse|raw_request/.test(response.body), 'no raw model data in the detail');
});

test('the detail of a document with a missing field shows the reason with its step and attempt, and the field as not found', async () => {
  const detail = (await app.inject({ url: `/api/documents/${missing}`, headers })).json();
  assert.equal(detail.status, 'NEEDS_REVIEW');
  assert.equal(detail.reasons.length, 1);
  assert.deepEqual({ code: detail.reasons[0].code, step: detail.reasons[0].step, attempt: detail.reasons[0].attempt }, { code: 'MISSING_REQUIRED_FIELD', step: 'check', attempt: 1 });
  const absent = detail.fields.find((field: { name: string }) => field.name === detail.reasons[0].params.field);
  assert.ok(absent, 'the missing field is listed');
  assert.deepEqual({ found: absent.found, verbatim: absent.verbatim, page: absent.page, value: absent.value }, { found: false, verbatim: null, page: null, value: null });
});

test('a document of no type has no fields and no extract step', async () => {
  const detail = (await app.inject({ url: `/api/documents/${untyped}`, headers })).json();
  assert.equal(detail.type, null);
  assert.deepEqual(detail.fields, []);
  assert.deepEqual(detail.reasons.map((reason: { code: string }) => reason.code), ['UNKNOWN_DOC_TYPE']);
  assert.deepEqual(detail.steps.map((step: { step: string }) => step.step), ['classify']);
  assert.equal(detail.model.schemaId, null);
});

test('an unknown number is 404 in the error shape and a malformed one is 400', async () => {
  const unknown = await app.inject({ url: '/api/documents/999999999', headers });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(Object.keys(unknown.json().error).sort(), ['code', 'message']);
  assert.equal(unknown.json().error.code, 'not_found');
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    assert.equal((await app.inject({ url: `/api/documents/${bad}`, headers })).statusCode, 400, bad);
    assert.equal((await app.inject({ url: `/api/documents/${bad}/raw`, headers })).statusCode, 400, `${bad} raw`);
  }
  assert.equal((await app.inject({ url: '/api/documents/999999999/raw', headers })).statusCode, 404);
});

test('the raw route holds the request and the response of each model call of that one document', async () => {
  const response = await app.inject({ url: `/api/documents/${accepted}/raw`, headers });
  assert.equal(response.statusCode, 200);
  const raw = response.json();
  assert.equal(raw.number, accepted);
  assert.deepEqual(raw.extractions.map((call: { kind: string }) => call.kind), ['classify', 'extract']);
  for (const call of raw.extractions) {
    assert.equal(typeof call.rawRequest, 'object');
    assert.equal(typeof call.rawResponse, 'object');
    assert.equal(call.adapter, 'replay');
    assert.ok(call.doneReason === 'stop');
  }
  const other = (await app.inject({ url: `/api/documents/${missing}/raw`, headers })).json();
  assert.notDeepEqual(other.extractions.map((call: { id: number }) => call.id), raw.extractions.map((call: { id: number }) => call.id));
});

/** The smallest PNG there is: the signature and an IHDR chunk are enough for a route that serves bytes as they are. */
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6ac4c0000000049454e44ae426082', 'hex');

test('a page preview is served as image/png with nosniff and a private cache; a missing page, file or document is 404', async () => {
  const sha = (await pool.query<{ sha256: string }>('SELECT sha256 FROM documents WHERE id = $1', [accepted])).rows[0]?.sha256 ?? '';
  const key = pageBlobKey(sha, 1);
  await mkdir(path.dirname(path.join(blobRoot, key)), { recursive: true });
  await writeFile(path.join(blobRoot, key), png);
  const response = await app.inject({ url: `/api/documents/${accepted}/pages/1.png`, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'private, max-age=3600');
  assert.deepEqual(response.rawPayload, png);

  assert.equal((await app.inject({ url: `/api/documents/${accepted}/pages/99.png`, headers })).statusCode, 404, 'no such page');
  assert.equal((await app.inject({ url: `/api/documents/${accepted}/pages/0.png`, headers })).statusCode, 400, 'pages start at 1');
  assert.equal((await app.inject({ url: `/api/documents/${missing}/pages/1.png`, headers })).statusCode, 404, 'the stored file is not there');
  assert.equal((await app.inject({ url: '/api/documents/999999999/pages/1.png', headers })).statusCode, 404);
});

test('a preview that is a link is not followed', async () => {
  const sha = (await pool.query<{ sha256: string }>('SELECT sha256 FROM documents WHERE id = $1', [untyped])).rows[0]?.sha256 ?? '';
  const key = pageBlobKey(sha, 1);
  await mkdir(path.dirname(path.join(blobRoot, key)), { recursive: true });
  await symlink(path.join(blobRoot, pageBlobKey((await pool.query<{ sha256: string }>('SELECT sha256 FROM documents WHERE id = $1', [accepted])).rows[0]?.sha256 ?? '', 1)), path.join(blobRoot, key));
  assert.equal((await app.inject({ url: `/api/documents/${untyped}/pages/1.png`, headers })).statusCode, 404);
});

test('no route serves an original, and the page rules still apply to the document routes', async () => {
  for (const url of [`/api/documents/${accepted}/original`, `/api/documents/${accepted}/file`, `/api/documents/${accepted}/download`, '/api/blobs/x', `/api/documents/${accepted}/pages/1`]) {
    assert.equal((await app.inject({ url, headers })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ url: '/api/documents', headers: { host: 'evil.example' } })).statusCode, 421);
  assert.equal((await app.inject({ url: `/api/documents/${accepted}`, headers: { ...headers, origin: 'http://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/documents/${accepted}/raw`, headers: { host: 'evil.example' } })).statusCode, 421);
  assert.equal((await stateOf(pool, accepted)).status, 'ACCEPTED', 'the refused requests changed nothing');
});
