import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type pg from 'pg';
import { createEvalReportValidator } from './config/ajv.ts';
import { loadConfig, resolveConfigDirs } from './config/load.ts';
import { thresholdNumber, thresholdSnapshot } from './config/thresholds.ts';
import type { ThresholdsFile } from './config/types.ts';
import { evalCallsOf, pagesOf, reasonsOf, stepRunsOf, fieldsOfExtraction, latestExtractionOf } from './db/queries.ts';
import type { EvalCallRow, FieldRow } from './db/queries.ts';
import { createPool } from './db/pool.ts';
import { createRegistry } from './registry/registry.ts';
import type { Registry, RegistryType } from './registry/registry.ts';
import { normalizeFragment } from './shared/normalize.ts';

/**
 * The evaluation command (FR-048, FR-048a, FR-049, constitution I): it compares what the pipeline stored for the fixtures
 * with the values the generator wrote down for them, prints the figures of the Measurement Contract and saves the same
 * figures with the thresholds in force and the verdict as one JSON report. It reads the database and the expected files and
 * writes nothing but the report; it never changes a document. The verdict follows the written threshold alone (100% of the
 * required fields of the fixtures expected ACCEPTED, no false accept, the ceilings of tokens and warm seconds per page), and
 * every difference from the expected status or reason codes is printed as well, because the model's errors are not to be hidden.
 * Nothing here is a decision about a model or a tier: the output says so.
 */

/** What the generator wrote for one fixture in `expected/<sha256>.json`. */
export type Expectation = {
  file: string;
  sha256: string;
  /** The type the document should be classified as, or `none`. */
  type: string;
  /** The typed value of each field the document carries: text, or an integer of minor units for money. */
  instance: Record<string, string | number>;
  status: string;
  codes: string[];
};

/** A defect of the evaluation's inputs: an expected file that cannot be read, or a report that does not match its contract. */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/** Narrows an arbitrary JSON value to an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one expected file; anything the evaluation relies on that is missing or of the wrong kind stops it with the file's name. */
function parseExpectation(file: string, value: unknown): Expectation {
  if (!isRecord(value)) {
    throw new EvalError(`${file} is not a JSON object`);
  }
  const { sha256, type, status, codes, instance } = value;
  if (typeof value['file'] !== 'string' || typeof sha256 !== 'string' || typeof type !== 'string' || typeof status !== 'string') {
    throw new EvalError(`${file} lacks file, sha256, type or status`);
  }
  if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string')) {
    throw new EvalError(`${file} has no list of reason codes`);
  }
  const fields: Record<string, string | number> = {};
  if (isRecord(instance)) {
    for (const [name, field] of Object.entries(instance)) {
      if (typeof field !== 'string' && typeof field !== 'number') {
        throw new EvalError(`${file}: the expected value of ${name} is neither text nor a number`);
      }
      fields[name] = field;
    }
  }
  return { file: value['file'], sha256, type, instance: fields, status, codes: codes.map(String) };
}

/** Loads every `*.json` of the expected folder, in the order of the file names. An empty or missing folder is an error. */
export async function loadExpectations(dir: string): Promise<Expectation[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    throw new EvalError(`The expected values could not be listed in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (names.length === 0) {
    throw new EvalError(`No expected values in ${dir}: run the fixtures generator first`);
  }
  const expectations: Expectation[] = [];
  for (const name of names) {
    expectations.push(parseExpectation(name, JSON.parse(await readFile(path.join(dir, name), 'utf8'))));
  }
  return expectations.sort((a, b) => a.file.localeCompare(b.file));
}

/** The figures of one fixture, as the report's `documents` carry them. */
export type DocumentFigures = {
  number: number;
  sha256: string;
  expectedStatus: string;
  status: string;
  expectedCodes: string[];
  codes: string[];
  fieldsExpected: number;
  fieldsMatched: number;
  falseAccepts: string[];
};

/** The report file of FR-048a (contracts/eval-report.schema.json). */
export type EvalReport = {
  version: 1;
  runAt: string;
  model: { name: string; digest: string };
  schemaIds: string[];
  promptHash: string;
  registryHash: string;
  thresholds: Record<string, number | string>;
  documents: DocumentFigures[];
  fieldMatch: number;
  requiredFieldMatchAccepted: number;
  falseAccepts: number;
  reasonShares: Record<string, number>;
  secondsPerPage: { parseCold: number | null; parseWarm: number | null; modelCold: number | null; modelWarm: number | null };
  tokensPerDocument: number;
  charsPerToken: number;
  verdict: 'pass' | 'fail';
  notATierDecision: true;
};

/** What `evaluate` hands back: the report, the lines to print and the reasons the verdict is a fail, if it is. */
export type EvalResult = {
  report: EvalReport;
  lines: string[];
  failures: string[];
};

/** What the evaluation reads: the database, the registry, the thresholds and the expected values. */
export type EvalDeps = {
  pool: pg.Pool;
  registry: Registry;
  thresholds: ThresholdsFile;
  expectations: Expectation[];
  now: Date;
};

/** A field that differs from what was expected, with both values for the printout. */
type Difference = { field: string; expected: string; got: string };

/** The value of a stored field in the form the expected files use: the amount of a money field, the text of any other. */
function comparable(row: FieldRow): string | number | null {
  const value = row.value;
  if (value === null || value === undefined) {
    return null;
  }
  if (row.kind === 'money' && isRecord(value) && typeof value['amount'] === 'number') {
    return value['amount'];
  }
  return typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value);
}

/** True when a stored value equals the expected one: money exactly, text after the pinned normalisation (FR-019). */
function sameValue(stored: string | number, expected: string | number): boolean {
  if (typeof stored === 'number' || typeof expected === 'number') {
    return stored === expected;
  }
  return normalizeFragment(stored) === normalizeFragment(expected);
}

/** The text of a value for a printout. */
function show(value: string | number | null): string {
  return value === null ? '(none)' : String(value);
}

/** The share a over b, 0 when there is nothing to divide by. */
function share(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

/** A share as a percentage with one decimal. */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A number with a fixed number of decimals, or `n/a` for a figure that was not measurable. */
function figure(value: number | null, decimals: number): string {
  return value === null ? 'n/a' : value.toFixed(decimals);
}

/** The distinct values of a list, sorted. */
function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** One hash over several: the one value itself when there is one, else the SHA-256 of the sorted values, so the report keeps a single string. */
function combined(values: string[]): string {
  const list = distinct(values);
  return list.length === 1 ? (list[0] ?? '') : createHash('sha256').update(list.join('\n')).digest('hex');
}

/** What the evaluation worked out about one fixture's document before the totals. */
type Judged = {
  figures: DocumentFigures;
  type: RegistryType | undefined;
  differences: Difference[];
  requiredExpected: number;
  requiredMatched: number;
  pages: number;
  parseSeconds: number | null;
  modelSeconds: number;
  calls: EvalCallRow[];
  present: boolean;
};

/** Compares one fixture with what the database holds for its hash. */
async function judge(deps: EvalDeps, expected: Expectation): Promise<Judged> {
  const { pool, registry } = deps;
  const found = await pool.query<{ id: number; status: string; accepted_extraction_id: number | null }>(
    'SELECT id, status, accepted_extraction_id FROM documents WHERE sha256 = $1',
    [expected.sha256],
  );
  const type = registry.byName.get(expected.type);
  const expectedNames = type === undefined ? [] : Object.keys(expected.instance);
  const row = found.rows[0];
  if (row === undefined) {
    return {
      figures: { number: 0, sha256: expected.sha256, expectedStatus: expected.status, status: 'MISSING', expectedCodes: expected.codes, codes: [], fieldsExpected: expectedNames.length, fieldsMatched: 0, falseAccepts: [] },
      type,
      differences: expectedNames.map((field) => ({ field, expected: show(expected.instance[field] ?? null), got: '(document missing)' })),
      requiredExpected: type === undefined ? 0 : type.fields.filter((field) => field.required && field.name in expected.instance).length,
      requiredMatched: 0,
      pages: 0,
      parseSeconds: null,
      modelSeconds: 0,
      calls: [],
      present: false,
    };
  }

  const codes = distinct((await reasonsOf(pool, row.id)).map((reason) => reason.code));
  const extraction = row.accepted_extraction_id !== null ? { id: row.accepted_extraction_id } : await latestExtractionOf(pool, row.id, 'extract');
  const stored = extraction === null ? [] : await fieldsOfExtraction(pool, extraction.id);
  const values = new Map(stored.map((field) => [field.name, comparable(field)] as const));

  const differences: Difference[] = [];
  const falseAccepts: string[] = [];
  let matched = 0;
  let requiredExpected = 0;
  let requiredMatched = 0;
  for (const field of type?.fields ?? []) {
    const wanted = expected.instance[field.name];
    const got = values.get(field.name) ?? null;
    if (wanted !== undefined) {
      const same = got !== null && sameValue(got, wanted);
      if (same) {
        matched += 1;
      } else {
        differences.push({ field: field.name, expected: show(wanted), got: show(got) });
      }
      if (field.required) {
        requiredExpected += 1;
        requiredMatched += same ? 1 : 0;
      }
    }
    // A value the document was accepted with that is not the expected one: wrong, or there when none was expected.
    if (row.status === 'ACCEPTED' && got !== null && (wanted === undefined || !sameValue(got, wanted))) {
      falseAccepts.push(field.name);
      if (wanted === undefined) {
        differences.push({ field: field.name, expected: show(null), got: show(got) });
      }
    }
  }
  if (row.status === 'ACCEPTED' && expected.status !== 'ACCEPTED') {
    falseAccepts.push('status');
  }

  const pages = (await pagesOf(pool, row.id)).length;
  const parseRuns = (await stepRunsOf(pool, row.id)).filter((run) => run.step === 'parse' && run.outcome === 'ok' && run.finished_at !== null);
  const lastParse = parseRuns[parseRuns.length - 1];
  const parseSeconds = lastParse?.finished_at ? (lastParse.finished_at.getTime() - lastParse.started_at.getTime()) / 1000 : null;
  const calls = await evalCallsOf(pool, row.id);
  const modelSeconds = calls.reduce((sum, call) => sum + (call.total_duration_ns ?? 0), 0) / 1e9;

  return {
    figures: { number: row.id, sha256: expected.sha256, expectedStatus: expected.status, status: row.status, expectedCodes: expected.codes, codes, fieldsExpected: expectedNames.length, fieldsMatched: matched, falseAccepts },
    type,
    differences,
    requiredExpected,
    requiredMatched,
    pages,
    parseSeconds,
    modelSeconds,
    calls,
    present: true,
  };
}

/** Seconds per page over a group of judged documents: parse and model time apart, null where the group has nothing to measure. */
function perPage(group: Judged[]): { parse: number | null; model: number | null } {
  const modelled = group.filter((doc) => doc.pages > 0 && doc.calls.length > 0);
  const pages = modelled.reduce((sum, doc) => sum + doc.pages, 0);
  const parsed = modelled.filter((doc) => doc.parseSeconds !== null);
  const parsedPages = parsed.reduce((sum, doc) => sum + doc.pages, 0);
  return {
    parse: parsedPages === 0 ? null : parsed.reduce((sum, doc) => sum + (doc.parseSeconds ?? 0), 0) / parsedPages,
    model: pages === 0 ? null : modelled.reduce((sum, doc) => sum + doc.modelSeconds, 0) / pages,
  };
}

/**
 * Judges the fixtures and works out every figure of the Measurement Contract. Cold and warm are told apart per document: a
 * document is cold when any of its model calls paid for loading the model (`extractions.cold`, set by the adapter), warm
 * otherwise, so the parse and model seconds of a cold document are never mixed into the warm figure the ceiling judges.
 */
export async function evaluate(deps: EvalDeps): Promise<EvalResult> {
  const judged: Judged[] = [];
  for (const expectation of deps.expectations) {
    judged.push(await judge(deps, expectation));
  }
  const present = judged.filter((doc) => doc.present);
  const typed = judged.filter((doc) => doc.type !== undefined);

  const fieldsExpected = typed.reduce((sum, doc) => sum + doc.figures.fieldsExpected, 0);
  const fieldsMatched = typed.reduce((sum, doc) => sum + doc.figures.fieldsMatched, 0);
  const accepted = judged.filter((doc) => doc.figures.expectedStatus === 'ACCEPTED');
  const requiredExpected = accepted.reduce((sum, doc) => sum + doc.requiredExpected, 0);
  const requiredMatched = accepted.reduce((sum, doc) => sum + doc.requiredMatched, 0);
  const falseAccepts = judged.reduce((sum, doc) => sum + doc.figures.falseAccepts.length, 0);

  const codeCounts = new Map<string, number>();
  for (const doc of present) {
    for (const code of doc.figures.codes) {
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
  }
  const reasonShares: Record<string, number> = {};
  for (const code of [...codeCounts.keys()].sort()) {
    reasonShares[code] = share(codeCounts.get(code) ?? 0, present.length);
  }

  const modelled = present.filter((doc) => doc.calls.length > 0);
  const cold = modelled.filter((doc) => doc.calls.some((call) => call.cold));
  const warm = modelled.filter((doc) => !doc.calls.some((call) => call.cold));
  const coldFigures = perPage(cold);
  const warmFigures = perPage(warm);
  const tokensPerDocument = share(
    modelled.reduce((sum, doc) => sum + doc.calls.reduce((inner, call) => inner + (call.prompt_eval_count ?? 0) + (call.eval_count ?? 0), 0), 0),
    modelled.length,
  );
  const calls = modelled.flatMap((doc) => doc.calls);
  const counted = calls.filter((call) => call.prompt_eval_count !== null && call.prompt_eval_count > 0);
  const charsPerToken = share(
    counted.reduce((sum, call) => sum + call.prompt_chars, 0),
    counted.reduce((sum, call) => sum + (call.prompt_eval_count ?? 0), 0),
  );

  const thresholds = thresholdSnapshot(deps.thresholds, ['eval.']);
  const passRequired = thresholdNumber(deps.thresholds, 'eval.pass_required_match');
  const maxFalseAccepts = thresholdNumber(deps.thresholds, 'eval.max_false_accepts');
  const tokenCeiling = thresholdNumber(deps.thresholds, 'eval.ceiling_tokens_per_document');
  const secondsCeiling = thresholdNumber(deps.thresholds, 'eval.ceiling_seconds_per_page_warm');
  const requiredMatch = share(requiredMatched, requiredExpected);
  const warmTotal = warmFigures.parse === null && warmFigures.model === null ? null : (warmFigures.parse ?? 0) + (warmFigures.model ?? 0);

  const failures: string[] = [];
  if (requiredExpected === 0 || requiredMatch < passRequired) {
    failures.push(`required fields of the ACCEPTED fixtures: ${percent(requiredMatch)} (${requiredMatched} of ${requiredExpected}), the threshold is ${percent(passRequired)} (eval.pass_required_match)`);
  }
  if (falseAccepts > maxFalseAccepts) {
    failures.push(`false accepts: ${falseAccepts}, at most ${maxFalseAccepts} (eval.max_false_accepts)`);
  }
  if (tokensPerDocument > tokenCeiling) {
    failures.push(`tokens per document: ${tokensPerDocument.toFixed(0)}, the ceiling is ${tokenCeiling} (eval.ceiling_tokens_per_document)`);
  }
  if (warmTotal !== null && warmTotal > secondsCeiling) {
    failures.push(`seconds per page warm: ${warmTotal.toFixed(2)}, the ceiling is ${secondsCeiling} (eval.ceiling_seconds_per_page_warm)`);
  }

  const digests = distinct(calls.map((call) => call.model_digest));
  const report: EvalReport = {
    version: 1,
    runAt: deps.now.toISOString(),
    model: { name: distinct(calls.map((call) => call.model_name)).join(', '), digest: digests.join(', ') },
    schemaIds: distinct(calls.flatMap((call) => (call.schema_id === null ? [] : [call.schema_id]))),
    promptHash: calls.length === 0 ? '' : combined(calls.map((call) => call.prompt_hash)),
    registryHash: calls.length === 0 ? '' : combined(calls.map((call) => call.registry_hash)),
    thresholds,
    documents: judged.map((doc) => doc.figures),
    fieldMatch: share(fieldsMatched, fieldsExpected),
    requiredFieldMatchAccepted: requiredMatch,
    falseAccepts,
    reasonShares,
    secondsPerPage: { parseCold: coldFigures.parse, parseWarm: warmFigures.parse, modelCold: coldFigures.model, modelWarm: warmFigures.model },
    tokensPerDocument,
    charsPerToken,
    verdict: failures.length === 0 ? 'pass' : 'fail',
    notATierDecision: true,
  };

  const lines: string[] = [];
  lines.push(`Evaluation of ${judged.length} fixtures, run at ${report.runAt}`);
  lines.push(`Model: ${report.model.name} (digest ${report.model.digest.slice(0, 12)})`);
  lines.push(`Schemas: ${report.schemaIds.join(', ') || '(none)'}`);
  lines.push(`Prompt hash: ${report.promptHash.slice(0, 12)}  Registry hash: ${report.registryHash.slice(0, 12)}`);
  lines.push('');
  lines.push('Per document (status expected -> got; fields matched; false accepts):');
  for (const [index, doc] of judged.entries()) {
    const file = deps.expectations[index]?.file ?? doc.figures.sha256.slice(0, 12);
    const figures = doc.figures;
    const status = figures.expectedStatus === figures.status ? figures.status : `${figures.expectedStatus} -> ${figures.status}`;
    const codesDiffer = distinct(figures.expectedCodes).join(',') !== figures.codes.join(',');
    lines.push(`  ${file.padEnd(24)} ${status.padEnd(34)} ${String(figures.fieldsMatched).padStart(2)}/${String(figures.fieldsExpected).padEnd(2)} fields${figures.falseAccepts.length > 0 ? `  FALSE ACCEPT: ${figures.falseAccepts.join(', ')}` : ''}${codesDiffer ? `  codes expected [${figures.expectedCodes.join(',')}] got [${figures.codes.join(',')}]` : ''}`);
    for (const difference of doc.differences) {
      lines.push(`      ${difference.field}: expected ${difference.expected}, got ${difference.got}`);
    }
  }
  lines.push('');
  lines.push(`Per-field match, typed fixtures: ${percent(report.fieldMatch)} (${fieldsMatched} of ${fieldsExpected} fields of ${typed.length} typed fixtures)`);
  lines.push(`Required fields of the ${accepted.length} fixtures expected ACCEPTED: ${percent(requiredMatch)} (${requiredMatched} of ${requiredExpected})`);
  lines.push(`False accepts over all ${judged.length} fixtures: ${falseAccepts}`);
  lines.push('Share of documents with each reason code:');
  for (const [code, value] of Object.entries(reasonShares)) {
    lines.push(`  ${code.padEnd(24)} ${percent(value)} (${codeCounts.get(code) ?? 0} of ${present.length})`);
  }
  if (Object.keys(reasonShares).length === 0) {
    lines.push('  (no reasons)');
  }
  lines.push(`Seconds per page, cold (${cold.length} documents): parse ${figure(coldFigures.parse, 2)}, model ${figure(coldFigures.model, 2)}  (printed, not judged)`);
  lines.push(`Seconds per page, warm (${warm.length} documents): parse ${figure(warmFigures.parse, 2)}, model ${figure(warmFigures.model, 2)}, together ${figure(warmTotal, 2)} (ceiling ${secondsCeiling})`);
  lines.push(`Tokens per document (prompt and generation): ${tokensPerDocument.toFixed(0)} over ${modelled.length} documents (ceiling ${tokenCeiling})`);
  lines.push(`Characters per token (prompt): ${charsPerToken.toFixed(3)} over ${counted.length} calls; the thresholds file holds ${thresholdNumber(deps.thresholds, 'model.chars_per_token')} (model.chars_per_token)`);
  lines.push('');
  lines.push(`Verdict: ${report.verdict.toUpperCase()}`);
  for (const failure of failures) {
    lines.push(`  below the threshold: ${failure}`);
  }
  lines.push('not a tier decision');
  return { report, lines, failures };
}

/** The file name of a report: the run date and time in UTC and the first twelve characters of the model digest (FR-048a). */
export function reportFileName(report: EvalReport): string {
  const stamp = report.runAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const digest = report.model.digest.replace(/^sha256:/, '').replace(/[^0-9a-f]/g, '').slice(0, 12) || 'nodigest';
  return `eval-${stamp}-${digest}.json`;
}

/**
 * Validates a report against its contract and writes it under `dir`. A file is never overwritten: a second report in the
 * same second stops with an error instead of replacing the first, because reports are the record of the measurements.
 */
export async function writeReport(dir: string, report: EvalReport): Promise<string> {
  const validate = await createEvalReportValidator();
  if (!validate(report)) {
    throw new EvalError(`The report does not match eval-report.schema.json: ${JSON.stringify(validate.errors)}`);
  }
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, reportFileName(report));
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return file;
}

/** Runs the evaluation as a command: prints the figures, saves the report, exits 0 on a pass and 1 below the threshold. */
async function main(): Promise<void> {
  const env = process.env;
  const config = await loadConfig(resolveConfigDirs(env));
  const expectedDir = env['READER_EXPECTED_DIR'] ?? path.join(env['READER_INBOX_DIR'] ?? 'inbox', 'expected');
  const resultsDir = env['READER_RESULTS_DIR'] ?? 'results';
  const pool = createPool((error) => console.error(`Idle database client failed: ${error.message}`));
  try {
    const result = await evaluate({
      pool,
      registry: createRegistry(config.typeSchemas),
      thresholds: config.thresholds,
      expectations: await loadExpectations(expectedDir),
      now: new Date(),
    });
    const file = await writeReport(resultsDir, result.report);
    console.log(result.lines.join('\n'));
    console.log(`Report: ${file}`);
    process.exitCode = result.report.verdict === 'pass' ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
