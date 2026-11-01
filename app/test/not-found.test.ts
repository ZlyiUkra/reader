import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { buildServer } from '../src/server.ts';

/**
 * What the server answers for a path it does not know (FR-067): the page itself with the status 404 and a base address of
 * `/` for a browser asking for a page, the JSON error for everything else, and the JSON error always under `/api`.
 */
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const reasons = createReasons(config.reasons);
const host = { host: '127.0.0.1:3000' };
const html = { ...host, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const page = '<!doctype html>\n<html lang="uk">\n  <head>\n    <title>Reader</title>\n    <script type="module" src="./assets/app.js"></script>\n  </head>\n  <body></body>\n</html>\n';

/** A server whose built page lives in `webRoot`, or none. */
async function server(webRoot: string | null): Promise<FastifyInstance> {
  return buildServer({
    logger: false,
    publicPort: 3000,
    webRoot,
    registry,
    reasons,
    pageSize: 20,
    pageSizes: [10, 20, 50, 100],
    sandbox: 'runc',
    checkDb: async () => true,
    checkParser: async () => true,
    readiness: async () => ({ state: 'missing', digest: null }),
  });
}

/** A folder with a built page and one asset, removed afterwards. */
async function withBuiltPage(run: (webRoot: string) => Promise<void>): Promise<void> {
  const webRoot = await mkdtemp(path.join(tmpdir(), 'reader-web-'));
  try {
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'index.html'), page);
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'export {};\n');
    await run(webRoot);
  } finally {
    await rm(webRoot, { recursive: true });
  }
}

test('a browser asking for an unknown path gets the page with the base address and the status 404, nested paths included', async () => {
  await withBuiltPage(async (webRoot) => {
    const app = await server(webRoot);
    for (const url of ['/nothing', '/a/b/c', '/nothing?x=1', '/documents/17']) {
      const response = await app.inject({ url, headers: html });
      assert.equal(response.statusCode, 404, url);
      assert.match(String(response.headers['content-type']), /^text\/html/, url);
      assert.ok(response.body.includes('<head><base href="/">'), url);
      assert.ok(response.body.includes('./assets/app.js'), url);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    await app.close();
  });
});

test('every other request for an unknown path, and everything under /api, keeps the JSON error', async () => {
  await withBuiltPage(async (webRoot) => {
    const app = await server(webRoot);
    const cases = [
      { url: '/assets/none.js', headers: { ...host, accept: '*/*' } },
      { url: '/nothing', headers: host },
      { url: '/api/nothing', headers: html },
      { url: '/api', headers: html },
      { method: 'POST' as const, url: '/nothing', headers: { ...html, origin: 'http://127.0.0.1:3000', 'x-reader-request': '1' } },
    ];
    for (const request of cases) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 404, request.url);
      assert.match(String(response.headers['content-type']), /^application\/json/, request.url);
      assert.deepEqual(response.json(), { error: { code: 'not_found', message: 'No such resource.' } }, request.url);
    }
    await app.close();
  });
});

test('the page and its files are still served, and a server without a built page answers the JSON error', async () => {
  await withBuiltPage(async (webRoot) => {
    const app = await server(webRoot);
    const root = await app.inject({ url: '/', headers: html });
    assert.equal(root.statusCode, 200);
    assert.ok(!root.body.includes('<base'), 'the page itself carries no base address');
    assert.equal((await app.inject({ url: '/assets/app.js', headers: host })).statusCode, 200);
    await app.close();
  });
  const bare = await server(null);
  const response = await bare.inject({ url: '/nothing', headers: html });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'not_found');
  await bare.close();
});

test('a built folder without a page answers the JSON error', async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'reader-web-'));
  try {
    const app = await server(empty);
    const response = await app.inject({ url: '/nothing', headers: html });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
    await app.close();
  } finally {
    await rm(empty, { recursive: true });
  }
});
