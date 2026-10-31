import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { classifySchema, wireSchema } from '../src/registry/wire.ts';

/**
 * Snapshots of the wire schemas and of the classification schema (T020, acceptance check 9). The schemas the model gets
 * are derived from the registry by pure functions; a snapshot per type makes any change to a type schema that alters
 * what the model receives show up here as a failing test. `UPDATE_SNAPSHOTS=1` rewrites the files; nothing else does.
 */
const registry = createRegistry((await loadConfig(resolveConfigDirs(process.env))).typeSchemas);
const snapshotDir = path.join(import.meta.dirname, 'fixtures', 'snapshots');

/** Compares `actual` with the stored snapshot, or writes the snapshot when `UPDATE_SNAPSHOTS=1` asks for it. */
async function matchSnapshot(name: string, actual: unknown): Promise<void> {
  const file = path.join(snapshotDir, name);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env['UPDATE_SNAPSHOTS'] === '1') {
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(file, text);
    return;
  }
  assert.equal(text, await readFile(file, 'utf8'), `${name} differs from the stored snapshot; rerun with UPDATE_SNAPSHOTS=1 if the change is intended`);
}

/** Every key of a value, at any depth, to prove that no `x-` key reaches the model. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(allKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...allKeys(inner)]);
  }
  return [];
}

for (const type of registry.types) {
  test(`${type.name}: the wire schema matches its snapshot`, async () => {
    await matchSnapshot(`${type.name}.wire.json`, wireSchema(type));
  });

  test(`${type.name}: the wire schema has no x- key and no format, pattern or enum`, () => {
    const keys = allKeys(wireSchema(type));
    assert.deepEqual(keys.filter((key) => key.startsWith('x-')), []);
    assert.deepEqual(keys.filter((key) => ['format', 'pattern', 'enum', '$id', '$schema', 'title'].includes(key)), []);
  });

  test(`${type.name}: every field is required and has an explicit absent path`, () => {
    const schema = wireSchema(type) as { required: string[]; properties: Record<string, unknown> };
    const names = type.fields.map((field) => field.name);
    assert.deepEqual(schema.required, names);
    assert.deepEqual(Object.keys(schema.properties), names);
    for (const name of names) {
      assert.deepEqual(schema.properties[name], {
        type: 'object',
        required: ['verbatim', 'page'],
        additionalProperties: false,
        properties: { verbatim: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] } },
      });
    }
  });
}

test('the classification schema lists the registered types in registry order, then none', async () => {
  const schema = classifySchema(registry.types.map((type) => type.name));
  assert.deepEqual(schema, {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties: { type: { enum: [...registry.types.map((type) => type.name), 'none'] } },
  });
  await matchSnapshot('classify.wire.json', schema);
});
