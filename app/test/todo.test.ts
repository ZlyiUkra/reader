import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { logTodoWarnings, todoList } from '../src/config/todo.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { buildServer } from '../src/server.ts';

/**
 * The named simplifications stay visible (constitution XII, FR-052, SC-011): every row of the Deferred Simplifications
 * table of the spec is in `config/todo.ts`, in the start-up WARN output and in the `todo` list of `/api/health`, in both
 * languages. The spec is the single source of the table, so the test reads the real file and nothing is copied by hand.
 */

/** Where the spec can be reached: next to the code in the test image (copied at build), or in the repository tree on the host. */
const specLocations = [new URL('../specs/spec.md', import.meta.url), new URL('../../specs/001-local-prototype/spec.md', import.meta.url)];

/** One row of the spec table: what is simplified and what ends the simplification. */
type SpecRow = { simplification: string; trigger: string };

/** Reads the spec from the first place it is found; a spec that cannot be found is a failure, never a skipped check. */
async function readSpec(): Promise<string> {
  for (const location of specLocations) {
    try {
      return await readFile(location, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  throw new Error('spec.md is not reachable from the tests: the image copies it to specs/spec.md at build time');
}

/** The rows of the table under "Deferred Simplifications": the first and the last column, without the markdown marks around them. */
function tableRows(spec: string): SpecRow[] {
  const start = spec.indexOf('## Deferred Simplifications');
  assert.notEqual(start, -1, 'the spec has no Deferred Simplifications section');
  const rest = spec.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.replaceAll('`', '').trim()))
    .filter((cells) => cells.length === 3 && cells[0] !== 'Simplification' && !cells[0]?.startsWith('---'))
    .map((cells) => ({ simplification: cells[0] ?? '', trigger: cells[2] ?? '' }));
}

/** The distinct words of a text that are long enough to carry meaning, lower-cased. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4));
}

/** The share of the words of `specText` that the program's text has too; the program may phrase a row a little differently, not drop its sense. */
function coverage(specText: string, programText: string): number {
  const wanted = words(specText);
  const have = words(programText);
  return wanted.size === 0 ? 1 : [...wanted].filter((word) => have.has(word)).length / wanted.size;
}

/** Below this share of a spec row's words the program's text is a different sentence, not a rephrasing. */
const minimumCoverage = 0.6;

test('the table of the spec and config/todo.ts hold the same simplifications, in the same order', async () => {
  const rows = tableRows(await readSpec());
  assert.equal(rows.length, todoList.length, `the spec table has ${rows.length} rows, config/todo.ts has ${todoList.length} items`);
  assert.equal(new Set(todoList.map((item) => item.id)).size, todoList.length, 'the ids of config/todo.ts are not unique');
  rows.forEach((row, index) => {
    const item = todoList[index];
    assert.ok(item !== undefined);
    const textShare = coverage(row.simplification, item.en);
    const triggerShare = coverage(row.trigger, item.trigger.en);
    assert.ok(textShare >= minimumCoverage, `row ${index + 1} of the spec ("${row.simplification}") is not what "${item.id}" says: ${textShare.toFixed(2)}`);
    assert.ok(triggerShare >= minimumCoverage, `the trigger of row ${index + 1} ("${row.trigger}") is not what "${item.id}" says: ${triggerShare.toFixed(2)}`);
  });
});

test('every simplification and its trigger are written in both languages', () => {
  const cyrillic = /[Ѐ-ӿ]/;
  for (const item of todoList) {
    for (const [name, uk, en] of [
      ['text', item.uk, item.en],
      ['trigger', item.trigger.uk, item.trigger.en],
    ] as const) {
      assert.ok(uk.length > 0 && en.length > 0, `${item.id}: the ${name} is missing in a language`);
      assert.match(uk, cyrillic, `${item.id}: the Ukrainian ${name} has no Ukrainian letters`);
      assert.doesNotMatch(en, cyrillic, `${item.id}: the English ${name} has Ukrainian letters`);
    }
  }
});

test('the start-up WARN output has one line for each simplification, with its id, its English text and its trigger', () => {
  const lines: { fields: object; message: string }[] = [];
  logTodoWarnings({ warn: (fields, message) => lines.push({ fields, message }) });
  assert.equal(lines.length, todoList.length);
  lines.forEach((line, index) => {
    const item = todoList[index];
    assert.ok(item !== undefined);
    assert.deepEqual(line.fields, { simplification: item.id, trigger: item.trigger.en });
    assert.equal(line.message, item.en);
  });
});

test('/api/health lists every simplification with both languages, as config/todo.ts has them', async () => {
  const config = await loadConfig(resolveConfigDirs(process.env));
  const app: FastifyInstance = await buildServer({
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
  });
  const health = (await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:3000' } })).json();
  assert.deepEqual(health.todo, todoList);
  await app.close();
});
