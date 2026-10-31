import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { todoList } from '../src/config/todo.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { buildServer } from '../src/server.ts';

/**
 * The server's own rules, without a database or a model (C15, FR-056, FR-041, acceptance check 13): the Host and
 * Origin hook, the error shape, the security headers, and the two routes the page reads. The pieces that need a real
 * database are checked against the running stack at the end of the slice.
 */
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const reasons = createReasons(config.reasons);

/** A server on port 3000 whose database answers as `dbUp` says. */
async function server(dbUp = true): Promise<FastifyInstance> {
  return buildServer({
    logger: false,
    publicPort: 3000,
    webRoot: null,
    registry,
    reasons,
    sandbox: 'runc',
    checkDb: async () => dbUp,
    readiness: async () => ({ state: 'missing', digest: null }),
  });
}

const host = { host: '127.0.0.1:3000' };

test('the page host answers, a foreign Host is refused with 421 and no side effect', async () => {
  const app = await server();
  assert.equal((await app.inject({ url: '/api/health', headers: host })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/health', headers: { host: 'localhost:3000' } })).statusCode, 200);
  for (const bad of ['evil.example', '127.0.0.1:3001', 'localhost', '127.0.0.1.evil.example:3000']) {
    const response = await app.inject({ url: '/api/health', headers: { host: bad } });
    assert.equal(response.statusCode, 421, bad);
    assert.equal(response.json().error.code, 'misdirected_request');
  }
  await app.close();
});

test('a state-changing request needs the own Origin and the marker header', async () => {
  const app = await server();
  app.post('/probe', async () => ({ done: true }));
  const own = { ...host, origin: 'http://127.0.0.1:3000', 'x-reader-request': '1' };
  assert.equal((await app.inject({ method: 'POST', url: '/probe', headers: own })).statusCode, 200);
  const refused: Array<[string, Record<string, string>]> = [
    ['no Origin and no header', host],
    ['no header', { ...host, origin: 'http://127.0.0.1:3000' }],
    ['no Origin', { ...host, 'x-reader-request': '1' }],
    ['a foreign Origin', { ...host, origin: 'http://evil.example', 'x-reader-request': '1' }],
    ['the wrong header value', { ...host, origin: 'http://127.0.0.1:3000', 'x-reader-request': '0' }],
    ['https for the own host', { ...host, origin: 'https://127.0.0.1:3000', 'x-reader-request': '1' }],
  ];
  for (const [name, headers] of refused) {
    const response = await app.inject({ method: 'POST', url: '/probe', headers });
    assert.equal(response.statusCode, 403, name);
    assert.equal(response.json().error.code, 'forbidden');
  }
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    assert.equal((await app.inject({ method, url: '/probe', headers: host })).statusCode, 403, method);
  }
  await app.close();
});

test('a read with a foreign Origin is refused, a read without Origin is not', async () => {
  const app = await server();
  assert.equal((await app.inject({ url: '/api/health', headers: { ...host, origin: 'http://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/health', headers: { ...host, origin: 'http://localhost:3000' } })).statusCode, 200);
  await app.close();
});

test('no CORS header is ever sent, and the security headers are there', async () => {
  const app = await server();
  for (const response of [
    await app.inject({ url: '/api/health', headers: host }),
    await app.inject({ url: '/api/nothing-here', headers: host }),
    await app.inject({ url: '/api/health', headers: { host: 'evil.example' } }),
    await app.inject({ method: 'OPTIONS', url: '/api/health', headers: { ...host, origin: 'http://evil.example', 'access-control-request-method': 'GET' } }),
  ]) {
    assert.deepEqual(Object.keys(response.headers).filter((name) => name.startsWith('access-control-')), []);
    assert.equal(response.headers['content-security-policy'], "default-src 'self';img-src 'self';frame-ancestors 'none'");
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  await app.close();
});

test('errors leave in one shape, and a server error does not name its cause', async () => {
  const app = await server();
  app.get('/boom', async () => {
    throw new Error('secret detail: password=hunter2');
  });
  const missing = await app.inject({ url: '/api/nothing-here', headers: host });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: { code: 'not_found', message: 'No such resource.' } });
  const boom = await app.inject({ url: '/boom', headers: host });
  assert.equal(boom.statusCode, 500);
  assert.deepEqual(boom.json(), { error: { code: 'internal_error', message: 'Internal error.' } });
  assert.doesNotMatch(boom.body, /hunter2/);
  await app.close();
});

test('health reports the database, the model, the sandbox and all thirteen named simplifications', async () => {
  const up = await server(true);
  const health = (await up.inject({ url: '/api/health', headers: host })).json();
  assert.equal(health.db, 'ok');
  assert.equal(health.model, 'missing');
  assert.equal(health.modelDigest, null);
  assert.equal(health.sandbox, 'runc');
  assert.equal(health.schemaVersion, 1);
  assert.equal(health.todo.length, 13);
  assert.deepEqual(health.todo.map((item: { id: string }) => item.id), todoList.map((item) => item.id));
  assert.ok(health.todo.every((item: { uk: string; en: string; trigger: { uk: string; en: string } }) => item.uk && item.en && item.trigger.uk && item.trigger.en));
  await up.close();

  const down = await server(false);
  assert.equal((await down.inject({ url: '/api/health', headers: host })).json().db, 'down');
  await down.close();
});

test('meta lists the registered types, the reasons with their variants and the statuses', async () => {
  const app = await server();
  const meta = (await app.inject({ url: '/api/meta', headers: host })).json();
  assert.deepEqual(meta.languages, ['uk', 'en']);
  assert.equal(meta.defaultLanguage, 'uk');
  assert.deepEqual(meta.types.map((type: { name: string }) => type.name), ['act', 'contract', 'invoice']);
  const invoice = meta.types.find((type: { name: string }) => type.name === 'invoice');
  assert.equal(invoice.schemaId, 'https://reader.local/schemas/invoice.v1.json');
  assert.equal(invoice.fields.length, 15);
  assert.deepEqual(invoice.fields[0], { name: 'number', kind: 'string', required: true, labels: { uk: 'Номер', en: 'Number' } });
  assert.equal(meta.reasons.length, 15);
  const failed = meta.reasons.find((reason: { code: string }) => reason.code === 'VALIDATION_FAILED');
  assert.equal(failed.variants.length, 5);
  assert.deepEqual(failed.params, ['field', 'fragment', 'page']);
  assert.equal(meta.reasons.find((reason: { code: string }) => reason.code === 'ENCRYPTED').variants, undefined);
  assert.deepEqual(meta.statuses, ['RECEIVED', 'PARSE', 'CLASSIFY', 'EXTRACT', 'CHECK', 'ACCEPTED', 'NEEDS_REVIEW', 'REJECTED', 'FAILED']);
  await app.close();
});
