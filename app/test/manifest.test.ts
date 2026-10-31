import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { test } from 'node:test';
import { createContractValidators } from '../src/config/ajv.ts';

/**
 * The parser manifest against its contract (contracts/parser-manifest.schema.json, FR-014). The golden manifests are what
 * the parser wrote for each of the eleven fixtures when slice 4 closed, saved in `fixtures/golden/`; they prove that the
 * parser and the schema agree. The parser's own code is not compiled in here: the files are its output, nothing more.
 */
const { parserManifest: validate } = await createContractValidators();
const goldenDir = path.join(import.meta.dirname, 'fixtures', 'golden');
const names = (await readdir(goldenDir)).filter((name) => name.endsWith('.manifest.json')).sort();

/** One golden manifest as parsed JSON. */
async function golden(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(goldenDir, name), 'utf8')) as Record<string, unknown>;
}

test('there is a golden manifest for each of the eleven fixtures', () => {
  assert.equal(names.length, 11);
});

test('every golden manifest validates', async () => {
  for (const name of names) {
    const manifest = await golden(name);
    assert.equal(validate(manifest), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test('a manifest with an extra key, at the top or in a page, does not validate', async () => {
  const manifest = await golden(names[0] ?? '');
  assert.equal(validate({ ...manifest, extra: 1 }), false);
  const pages = (manifest['pages'] as Array<Record<string, unknown>>).map((page) => ({ ...page, path: '../../etc/passwd' }));
  assert.equal(validate({ ...manifest, pages }), false);
});

test('a manifest that breaks a bound does not validate: too many pages, a job id of another shape, a missing key', async () => {
  const manifest = await golden(names[0] ?? '');
  assert.equal(validate({ ...manifest, pageCount: 51 }), false);
  assert.equal(validate({ ...manifest, jobId: '../../x' }), false);
  const { limitsHit, ...without } = manifest;
  assert.ok(Array.isArray(limitsHit));
  assert.equal(validate(without), false);
});
