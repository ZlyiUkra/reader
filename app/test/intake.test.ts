import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { after, test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { countDocuments } from '../src/db/queries.ts';
import { listInbox, readInbox } from '../src/intake/inbox.ts';
import { blobKeyOf } from '../src/intake/store.ts';
import type { IntakeDeps } from '../src/intake/take.ts';
import { testDatabase } from './support/db.ts';

/**
 * Taking files in from the inbox against the real PostgreSQL (FR-001 to FR-006, acceptance checks 5 and 6): what the folder
 * lists, what a read takes, what a second read and a renamed copy answer, how the class is chosen, and what is skipped.
 * Every file's content carries a fresh random token, because `reader_test` keeps the documents of earlier runs and the
 * identity of a document is its content.
 */
const database = await testDatabase();
const pool = database.pool;
after(() => database.close());
const { classes } = await loadConfig(resolveConfigDirs(process.env));
const quiet = { info: () => undefined, warn: () => undefined };

const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');

/** A fresh inbox with the given files (name to content), an empty blob root and the deps that read them. */
async function setup(files: Record<string, string>, maxBytes = 1000): Promise<{ deps: IntakeDeps; inboxDir: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  const inboxDir = path.join(root, 'inbox');
  const blobRoot = path.join(root, 'blobs');
  await mkdir(inboxDir);
  await mkdir(blobRoot);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(inboxDir, name), content);
  }
  return { deps: { pool, inboxDir, blobRoot, maxBytes, classes, logger: quiet }, inboxDir, blobRoot };
}

test('the listing shows the regular files at the top level and nothing the generator or the system owns', async () => {
  const token = randomUUID();
  const { inboxDir } = await setup({ 'b.txt': `b ${token}`, 'a.txt': `a ${token}`, '.hidden': 'x', 'manifest.json': '[]' });
  await mkdir(path.join(inboxDir, 'expected'));
  await writeFile(path.join(inboxDir, 'expected', 'one.json'), '{}');
  await symlink(path.join(inboxDir, 'a.txt'), path.join(inboxDir, 'link.txt'));
  const listing = await listInbox(inboxDir);
  assert.equal(listing.path, inboxDir);
  assert.deepEqual(listing.files.map((file) => [file.name, file.sizeBytes]), [['a.txt', 38], ['b.txt', 38]]);
  assert.match(listing.files[0]?.modifiedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('a read takes new files in, a second read and a renamed copy are duplicates and the count does not move', async () => {
  const token = randomUUID();
  const { deps, inboxDir, blobRoot } = await setup({ 'a.txt': `alpha ${token}`, 'b.txt': `beta ${token}` });

  const first = await readInbox(deps);
  assert.deepEqual(first.duplicates, []);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.taken.map((entry) => entry.name), ['a.txt', 'b.txt']);
  assert.ok(first.taken.every((entry) => entry.class === 'unverified'));
  assert.equal(first.taken[0]?.sha256, sha256Of(`alpha ${token}`));
  assert.equal((first.taken[1]?.number ?? 0) - (first.taken[0]?.number ?? 0), 1, 'the numbers follow one another');
  const countAfterFirst = await countDocuments(pool);

  const second = await readInbox(deps);
  assert.deepEqual(second.taken, []);
  assert.deepEqual(second.duplicates.map((entry) => [entry.name, entry.originalNumber, entry.code]), [
    ['a.txt', first.taken[0]?.number, 'DUPLICATE'],
    ['b.txt', first.taken[1]?.number, 'DUPLICATE'],
  ]);

  await copyFile(path.join(inboxDir, 'a.txt'), path.join(inboxDir, 'renamed copy.txt'));
  const third = await readInbox(deps);
  assert.deepEqual(third.taken, []);
  assert.equal(third.duplicates.find((entry) => entry.name === 'renamed copy.txt')?.originalNumber, first.taken[0]?.number);
  assert.equal(await countDocuments(pool), countAfterFirst, 'the documents count did not change');

  // The original is stored under its hash, byte for byte, and no temporary file is left behind.
  assert.equal(await readFile(path.join(blobRoot, blobKeyOf(sha256Of(`alpha ${token}`))), 'utf8'), `alpha ${token}`);
  assert.deepEqual(await readdir(path.join(blobRoot, 'tmp')), []);
  const row = await pool.query('SELECT original_name, original_path, status, size_bytes FROM documents WHERE id = $1', [first.taken[0]?.number]);
  assert.deepEqual(row.rows[0], { original_name: 'a.txt', original_path: 'a.txt', status: 'RECEIVED', size_bytes: 42 });
});

test('a file whose hash is in the generator manifest is synthetic, any other is unverified', async () => {
  const token = randomUUID();
  const fixture = `fixture ${token}`;
  const { deps } = await setup({
    'fixture.txt': fixture,
    'outside.txt': `outside ${token}`,
    'manifest.json': JSON.stringify([{ file: 'fixture.txt', sha256: sha256Of(fixture), type: 'invoice', format: 'pdf', expected: 'expected/x.json' }]),
  });
  const result = await readInbox(deps);
  assert.deepEqual(result.taken.map((entry) => [entry.name, entry.class]), [['fixture.txt', 'synthetic'], ['outside.txt', 'unverified']]);
  assert.deepEqual(result.skipped, [], 'the manifest itself is not a document');
});

test('a broken manifest can only make documents unverified, never synthetic', async () => {
  const token = randomUUID();
  const { deps } = await setup({ 'a.txt': `a ${token}`, 'manifest.json': '{ not json' });
  const result = await readInbox(deps);
  assert.deepEqual(result.taken.map((entry) => entry.class), ['unverified']);
});

test('a link and a file over the limit are skipped and the others are still taken', async () => {
  const token = randomUUID();
  const { deps, inboxDir } = await setup({ 'big.bin': 'x'.repeat(2000), 'ok.txt': `ok ${token}` });
  await symlink(path.join(inboxDir, 'ok.txt'), path.join(inboxDir, 'link.txt'));
  const result = await readInbox(deps);
  assert.deepEqual(result.taken.map((entry) => entry.name), ['ok.txt']);
  assert.deepEqual(result.skipped, [
    { name: 'big.bin', reason: 'too_large' },
    { name: 'link.txt', reason: 'not_regular' },
  ]);
});
