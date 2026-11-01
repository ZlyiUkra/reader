import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { evaluate, loadExpectations, reportFileName, writeReport } from '../src/eval.ts';
import type { Expectation } from '../src/eval.ts';
import { fieldsOfExtraction } from '../src/db/queries.ts';
import { modelSettings } from '../src/llm/settings.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { endOpenDocuments, testDatabase, uniqueSha256 } from './support/db.ts';
import { addParsedFixture, fixtureReplay, startPipeline, waitForTerminal } from './support/pipeline-harness.ts';

/**
 * The evaluation on a replayed run (T063, FR-048, FR-049, acceptance check 14 without the GPU): the eleven fixtures go through
 * the real worker with the recorded replies of the real model. The recorded replies are what the real model once answered,
 * so they carry its mistakes (an OCR prefix inside a number, a full stop kept at the end of a sentence); judged against the
 * generator's own expected values they miss the written threshold, and that is a measurement, not a defect of the test. The
 * mechanics are therefore tested on the expected values of a run that the replay describes: the ACCEPTED fixtures expect what
 * the run stored. Such a run passes with exit 0 and a report that fits its contract; the same run judged against a copy with
 * one amount changed fails with a non-zero exit and says which threshold it is below. The command itself is started as a
 * process, so the exit code and the printed line are those the owner sees.
 */
const database = await testDatabase();
const pool = database.pool;
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const expectedDir = path.join(import.meta.dirname, 'fixtures', 'expected');
const appRoot = path.join(import.meta.dirname, '..');
const run = promisify(execFile);

let expectations: Expectation[] = [];

before(async () => {
  await endOpenDocuments(pool);
  // The test database keeps its rows for good (the role cannot delete), so every run gives the fixtures hashes of its own.
  expectations = (await loadExpectations(expectedDir)).map((expectation) => ({ ...expectation, sha256: uniqueSha256() }));
  const ids: number[] = [];
  for (const expectation of expectations) {
    ids.push(await addParsedFixture(pool, expectation.file, expectation.sha256));
  }
  const worker = startPipeline({ pool, adapter: fixtureReplay(), classes: config.classes, registry, thresholds: config.thresholds, settings: modelSettings(config.thresholds), logger: quiet });
  try {
    await waitForTerminal(pool, ids, 60_000);
  } finally {
    await worker.stop();
  }
});
after(() => database.close());

/** The expected values of the replayed run: each ACCEPTED fixture expects the values the run stored for it, the others stay as the generator wrote them. */
async function describedByRun(): Promise<Expectation[]> {
  const described: Expectation[] = [];
  for (const expectation of expectations) {
    const row = (await pool.query<{ accepted_extraction_id: number | null }>('SELECT accepted_extraction_id FROM documents WHERE sha256 = $1', [expectation.sha256])).rows[0];
    if (expectation.status !== 'ACCEPTED' || row?.accepted_extraction_id == null) {
      described.push(expectation);
      continue;
    }
    const instance: Record<string, string | number> = {};
    for (const field of await fieldsOfExtraction(pool, row.accepted_extraction_id)) {
      const value = field.value;
      if (typeof value === 'string') {
        instance[field.name] = value;
      } else if (typeof value === 'object' && value !== null && 'amount' in value && typeof value.amount === 'number') {
        instance[field.name] = value.amount;
      }
    }
    described.push({ ...expectation, instance });
  }
  return described;
}

/** Writes expected values to a new folder, one file per fixture, as the generator does. */
async function writeExpectations(list: Expectation[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reader-expected-'));
  await mkdir(dir, { recursive: true });
  for (const expectation of list) {
    await writeFile(path.join(dir, `${expectation.sha256}.json`), JSON.stringify(expectation));
  }
  return dir;
}

/** The same expected values with the gross total of one fixture raised by a euro, a sum that cannot be read as the same. */
function withChangedAmount(list: Expectation[], file: string): Expectation[] {
  return list.map((expectation) => {
    const total = expectation.instance['totalGross'];
    return expectation.file === file && typeof total === 'number' ? { ...expectation, instance: { ...expectation.instance, totalGross: total + 100 } } : expectation;
  });
}

/** The evaluation command as a process over the test database, with the given expected folder and a results folder of its own. */
async function command(expected: string, results: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, ['src/eval.ts'], {
      cwd: appRoot,
      env: { ...process.env, PGDATABASE: 'reader_test', READER_EXPECTED_DIR: expected, READER_RESULTS_DIR: results },
    });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '' };
  }
}

test('a replayed run that the expected values describe passes the threshold, and every figure of the Measurement Contract is there', async () => {
  const result = await evaluate({ pool, registry, thresholds: config.thresholds, expectations: await describedByRun(), now: new Date('2026-11-01T12:00:00Z') });
  assert.deepEqual(result.failures, [], result.lines.join('\n'));
  const report = result.report;
  assert.equal(report.verdict, 'pass');
  assert.equal(report.requiredFieldMatchAccepted, 1);
  assert.equal(report.falseAccepts, 0);
  assert.equal(report.documents.length, 11);
  assert.ok(report.fieldMatch > 0 && report.fieldMatch <= 1);
  assert.ok(report.tokensPerDocument > 0 && report.tokensPerDocument < 6000);
  assert.ok(report.charsPerToken > 0);
  assert.ok(report.model.digest.length > 0 && report.schemaIds.length === 3 && report.promptHash.length > 0 && report.registryHash.length > 0);
  assert.ok(Object.keys(report.reasonShares).includes('UNKNOWN_DOC_TYPE'));
  const text = result.lines.join('\n');
  for (const part of ['Per-field match', 'Share of documents with each reason code', 'Seconds per page, cold', 'Seconds per page, warm', 'Tokens per document', 'False accepts', 'Model:', 'Schemas:', 'Prompt hash', 'not a tier decision']) {
    assert.ok(text.includes(part), `the printout has "${part}"`);
  }
});

test('the report is written once under a name of the run time and the model digest, validated, and never overwritten', async () => {
  const result = await evaluate({ pool, registry, thresholds: config.thresholds, expectations: await describedByRun(), now: new Date('2026-11-01T12:00:00Z') });
  const dir = await mkdtemp(path.join(tmpdir(), 'reader-results-'));
  const file = await writeReport(dir, result.report);
  assert.equal(path.basename(file), reportFileName(result.report));
  assert.match(path.basename(file), /^eval-20261101-120000-[0-9a-f]{12}\.json$/);
  const written: unknown = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(result.report)));
  await assert.rejects(() => writeReport(dir, result.report), /EEXIST/, 'a second report of the same second does not replace the first');
  await assert.rejects(() => writeReport(dir, { ...result.report, runAt: 'not a date' }), /eval-report/, 'a report that breaks its contract is not written');
});

test('a changed expected amount fails the run: a required field and a false accept, both named', async () => {
  const result = await evaluate({ pool, registry, thresholds: config.thresholds, expectations: withChangedAmount(await describedByRun(), 'invoice-1.pdf'), now: new Date() });
  assert.equal(result.report.verdict, 'fail');
  assert.ok(result.report.requiredFieldMatchAccepted < 1);
  assert.ok(result.report.falseAccepts >= 1);
  assert.ok(result.failures.some((failure) => failure.includes('eval.pass_required_match')));
  assert.ok(result.failures.some((failure) => failure.includes('eval.max_false_accepts')));
  const invoice = result.report.documents.find((doc) => doc.sha256 === expectations.find((candidate) => candidate.file === 'invoice-1.pdf')?.sha256);
  assert.deepEqual(invoice?.falseAccepts, ['totalGross']);
  assert.ok(result.lines.some((line) => /totalGross: expected \d+, got \d+/.test(line)), 'the printout shows the expected and the stored value');
});

test('as a command: exit 0 and one new report on a matching run, a non-zero exit below the threshold, and the line in both', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'reader-results-'));
  const described = await describedByRun();
  const pass = await command(await writeExpectations(described), results);
  assert.equal(pass.code, 0, pass.stdout);
  assert.ok(pass.stdout.includes('not a tier decision'));
  assert.equal((await readdir(results)).length, 1, 'exactly one report file per run');

  const failResults = await mkdtemp(path.join(tmpdir(), 'reader-results-'));
  const fail = await command(await writeExpectations(withChangedAmount(described, 'invoice-1.pdf')), failResults);
  assert.equal(fail.code, 1, fail.stdout);
  assert.ok(fail.stdout.includes('not a tier decision'));
  assert.ok(fail.stdout.includes('below the threshold'));
  assert.equal((await readdir(failResults)).length, 1, 'a failed run also leaves its report');
});
