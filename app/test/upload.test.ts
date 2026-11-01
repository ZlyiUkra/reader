import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { after, test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { countDocuments } from '../src/db/queries.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { buildServer } from '../src/server.ts';
import { testDatabase } from './support/db.ts';

/**
 * The upload route against the real PostgreSQL (FR-003, FR-004, acceptance check 6): a new file is stored under its hash and
 * answered 201 as `unverified`, the same bytes again answer DUPLICATE with the original's number and add nothing, a file over
 * the limit answers 413 and leaves nothing behind, and the request rules of the server apply.
 */
const database = await testDatabase();
const pool = database.pool;
after(() => database.close());
const config = await loadConfig(resolveConfigDirs(process.env));

const root = await mkdtemp(path.join(tmpdir(), 'upload-'));
const inboxDir = path.join(root, 'inbox');
const blobRoot = path.join(root, 'blobs');
await mkdir(inboxDir);
await mkdir(blobRoot);
const maxBytes = 300;

const app = await buildServer({
  logger: false,
  publicPort: 3000,
  webRoot: null,
  registry: createRegistry(config.typeSchemas),
  reasons: createReasons(config.reasons),
  pageSize: 20,
  pageSizes: [10, 20, 50, 100],
  sandbox: 'runc',
  checkDb: async () => true,
  checkParser: async () => true,
  readiness: async () => ({ state: 'missing', digest: null }),
  intake: { pool, inboxDir, blobRoot, maxBytes, classes: config.classes, logger: { info: () => undefined, warn: () => undefined } },
});
after(() => app.close());

const allowed = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-reader-request': '1' };

/** A multipart body with one part, as a browser form would send it. */
function multipart(field: string, filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----reader${randomUUID()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { ...allowed, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('a new file is stored and answered 201 as unverified; the same bytes again are a DUPLICATE with the same number', async () => {
  const content = Buffer.from(`upload ${randomUUID()}`);
  const first = await app.inject({ method: 'POST', url: '/api/documents', ...multipart('file', 'one.txt', content) });
  assert.equal(first.statusCode, 201);
  const created = first.json();
  assert.deepEqual(Object.keys(created).sort(), ['class', 'number', 'sha256', 'status']);
  assert.deepEqual({ class: created.class, status: created.status }, { class: 'unverified', status: 'RECEIVED' });
  const countAfterFirst = await countDocuments(pool);

  const again = await app.inject({ method: 'POST', url: '/api/documents', ...multipart('file', 'another name.txt', content) });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { code: 'DUPLICATE', originalNumber: created.number, sha256: created.sha256 });
  assert.equal(await countDocuments(pool), countAfterFirst, 'the documents count did not change');
  assert.deepEqual(await readdir(path.join(blobRoot, 'tmp')), [], 'no temporary file is left behind');

  const row = await pool.query('SELECT original_name, original_path, status FROM documents WHERE id = $1', [created.number]);
  assert.deepEqual(row.rows[0], { original_name: 'one.txt', original_path: null, status: 'RECEIVED' });
});

test('a file over the limit answers 413 too_large, stores nothing and leaves no temporary file', async () => {
  const before = await countDocuments(pool);
  const response = await app.inject({ method: 'POST', url: '/api/documents', ...multipart('file', 'big.bin', Buffer.alloc(maxBytes + 1, 120)) });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'too_large');
  assert.equal(await countDocuments(pool), before);
  assert.deepEqual(await readdir(path.join(blobRoot, 'tmp')), []);
});

test('a file of exactly the limit is accepted', async () => {
  const content = Buffer.from(`${randomUUID()}${'y'.repeat(maxBytes)}`).subarray(0, maxBytes);
  const response = await app.inject({ method: 'POST', url: '/api/documents', ...multipart('file', 'edge.bin', content) });
  assert.equal(response.statusCode, 201);
});

test('a request without the file field, or that is not multipart, is a 4xx in the error shape', async () => {
  const wrongField = await app.inject({ method: 'POST', url: '/api/documents', ...multipart('upload', 'x.txt', Buffer.from('x')) });
  assert.equal(wrongField.statusCode, 400);
  assert.equal(wrongField.json().error.code, 'bad_request');
  const notMultipart = await app.inject({ method: 'POST', url: '/api/documents', headers: { ...allowed, 'content-type': 'application/json' }, payload: '{}' });
  assert.ok(notMultipart.statusCode >= 400 && notMultipart.statusCode < 500, `status ${notMultipart.statusCode}`);
  assert.ok(notMultipart.json().error.code);
});

test('the Origin and header rules apply: an upload without them is refused with no side effect', async () => {
  const before = await countDocuments(pool);
  const form = multipart('file', 'x.txt', Buffer.from(`refused ${randomUUID()}`));
  const { origin: _origin, ...withoutOrigin } = form.headers;
  const noOrigin = await app.inject({ method: 'POST', url: '/api/documents', payload: form.payload, headers: withoutOrigin });
  assert.equal(noOrigin.statusCode, 403);
  const { 'x-reader-request': _marker, ...withoutMarker } = form.headers;
  const noMarker = await app.inject({ method: 'POST', url: '/api/documents', payload: form.payload, headers: withoutMarker });
  assert.equal(noMarker.statusCode, 403);
  assert.equal(await countDocuments(pool), before);
});
