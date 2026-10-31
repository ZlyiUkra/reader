import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { after, beforeEach, test } from 'node:test';
import { createContractValidators } from '../src/config/ajv.ts';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { claimNext } from '../src/db/claim.ts';
import { reasonsOf, stepRunsOf } from '../src/db/queries.ts';
import { blobKeyOf, pageBlobKey } from '../src/intake/store.ts';
import { ParserClientError } from '../src/parser-client/client.ts';
import { UnsafeOutputError } from '../src/parser-client/safe-read.ts';
import { failureOf, recordFailure } from '../src/pipeline/failures.ts';
import { leaseSeconds } from '../src/pipeline/lease.ts';
import { createParseStep } from '../src/pipeline/parse.ts';
import { addDocument, endOpenDocuments, stateOf, testDatabase } from './support/db.ts';
import { pageEntry, pngOf, startFakeParser, writeOutput } from './support/fake-parser.ts';

/**
 * The parse step (FR-009 to FR-014, FR-016, FR-027, FR-030) against the real PostgreSQL and a stand-in for the parser's
 * socket: what is stored when the parser answers well, which reason ends the document when it answers badly, how the two
 * reading-quality rules decide, and that a hostile output or an unreachable parser leaves the document to be retried.
 * The real parser is exercised against the running stack at the end of the slice.
 */
const database = await testDatabase();
const pool = database.pool;
const config = await loadConfig(resolveConfigDirs(process.env));
const validators = await createContractValidators();

const root = await mkdtemp(path.join(tmpdir(), 'parse-step-'));
const jobsDir = path.join(root, 'jobs');
const blobRoot = path.join(root, 'blobs');
await mkdir(path.join(jobsDir, 'in'), { recursive: true });
await mkdir(path.join(jobsDir, 'out'), { recursive: true });
await mkdir(blobRoot);

const fake = await startFakeParser(jobsDir, async () => ({ ok: false, code: 'INTERNAL_ERROR', params: { cause: 'unset' } }));
after(async () => {
  await fake.close();
  await database.close();
});
beforeEach(() => endOpenDocuments(pool));

const quiet = { info: () => undefined, warn: () => undefined };
const step = createParseStep({ pool, thresholds: config.thresholds, validateManifest: validators.parserManifest, jobsDir, blobRoot, logger: quiet });
const claimOptions = { steps: ['parse' as const], leaseSeconds: () => leaseSeconds('parse', config.thresholds), instanceId: 'test' };

/** A document whose original is in the blob store, claimed and ready for the step. */
async function claimedDocument() {
  const doc = await addDocument(pool);
  await mkdir(path.dirname(path.join(blobRoot, blobKeyOf(doc.sha256))), { recursive: true });
  await writeFile(path.join(blobRoot, blobKeyOf(doc.sha256)), 'original bytes');
  const claimed = await claimNext(pool, claimOptions);
  assert.equal(claimed?.document.id, doc.id);
  return { doc, claimed };
}

const readable = 'a'.repeat(400);

test('a good output is stored: pages, texts with the thresholds in force, the mime, and the document waits at CLASSIFY', async () => {
  fake.behave((jobId, outDir) => writeOutput(jobId, outDir, [{ entry: pageEntry(1, 'text_layer'), text: readable }, { entry: pageEntry(2, 'ocr', 70, 5), text: readable }]));
  const { doc, claimed } = await claimedDocument();
  await step(claimed);

  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts, by: state.locked_by }, { status: 'CLASSIFY', attempts: 1, by: null });
  const pages = await pool.query<{ page_no: number; width_px: number; png_blob_key: string; source: string; engine: string; dpi: number | null; text: string; thresholds: Record<string, number> }>(
    `SELECT p.page_no, p.width_px, p.png_blob_key, t.source, t.engine, t.dpi, t.text, t.thresholds
     FROM pages p JOIN page_texts t ON t.page_id = p.id WHERE p.document_id = $1 ORDER BY p.page_no`,
    [doc.id],
  );
  assert.deepEqual(pages.rows.map((row) => [row.page_no, row.source, row.engine, row.dpi, row.png_blob_key]), [
    [1, 'text_layer', 'pdftotext', null, pageBlobKey(doc.sha256, 1)],
    [2, 'ocr', 'tesseract', 300, pageBlobKey(doc.sha256, 2)],
  ]);
  assert.equal(pages.rows[0]?.text, readable);
  assert.equal(pages.rows[0]?.thresholds['parser.page_cap'], 50);
  assert.equal(pages.rows[0]?.thresholds['quality.empty_min_chars'], 20);
  assert.equal(pages.rows[0]?.thresholds['model.num_ctx'], undefined, 'only the parser and quality rows are snapshotted');
  assert.deepEqual(await readFile(path.join(blobRoot, pageBlobKey(doc.sha256, 1))), pngOf(8, 8));
  const mime = await pool.query<{ detected_mime: string }>('SELECT detected_mime FROM documents WHERE id = $1', [doc.id]);
  assert.equal(mime.rows[0]?.detected_mime, 'application/pdf');
  const run = (await stepRunsOf(pool, doc.id))[0];
  assert.equal(run?.outcome, 'ok');
  assert.equal(run?.details?.['pageCount'], 2);
  assert.equal(typeof run?.details?.['jobId'], 'string');
  assert.deepEqual(await reasonsOf(pool, doc.id), []);
});

test('the original is copied for the parser under a fresh job id and the job id is never the hash', async () => {
  fake.behave((jobId, outDir) => writeOutput(jobId, outDir, [{ entry: pageEntry(1, 'text_layer'), text: readable }]));
  const { doc, claimed } = await claimedDocument();
  await step(claimed);
  const jobId = fake.requests.at(-1) ?? '';
  assert.match(jobId, /^[a-z0-9]{32}$/);
  assert.notEqual(jobId, doc.sha256.slice(0, 32));
  assert.equal(await readFile(path.join(jobsDir, 'in', jobId, 'input'), 'utf8'), 'original bytes');
});

test('a blank document ends NEEDS_REVIEW with EMPTY and is not classified', async () => {
  fake.behave((jobId, outDir) => writeOutput(jobId, outDir, [{ entry: pageEntry(1, 'ocr', 0, 0), text: '' }]));
  const { doc, claimed } = await claimedDocument();
  await step(claimed);
  assert.equal((await stateOf(pool, doc.id)).status, 'NEEDS_REVIEW');
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => [reason.code, reason.params]), [['EMPTY', { blankPages: 1, pages: 1, minChars: 20 }]]);
  assert.equal((await stepRunsOf(pool, doc.id))[0]?.outcome, 'reason');
});

test('a page of noise ends NEEDS_REVIEW with LOW_OCR_QUALITY', async () => {
  fake.behave((jobId, outDir) => writeOutput(jobId, outDir, [{ entry: pageEntry(1, 'ocr', 79, 76), text: 'x'.repeat(162) }]));
  const { doc, claimed } = await claimedDocument();
  await step(claimed);
  assert.equal((await stateOf(pool, doc.id)).status, 'NEEDS_REVIEW');
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => [reason.code, reason.params]), [
    ['LOW_OCR_QUALITY', { lowPages: 1, ocrPages: 1, share: 0.4, minConfidence: 60 }],
  ]);
});

test('each reason the parser reports ends the document REJECTED after one attempt, with the parser\'s parameters', async () => {
  const cases: Array<[string, Record<string, string | number>]> = [
    ['TOO_LARGE', { limit: 'page_cap', actual: 5000, max: 50 }],
    ['CORRUPT', { tool: 'soffice' }],
    ['ENCRYPTED', {}],
    ['UNSUPPORTED_FORMAT', { mime: 'application/zip' }],
  ];
  for (const [code, params] of cases) {
    fake.behave(async () => ({ ok: false, code, params }));
    const { doc, claimed } = await claimedDocument();
    await step(claimed);
    const state = await stateOf(pool, doc.id);
    assert.deepEqual({ status: state.status, attempts: state.attempts }, { status: 'REJECTED', attempts: 1 }, code);
    assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => [reason.code, reason.params]), [[code, params]], code);
    const stored = await pool.query<{ count: number }>('SELECT count(*) AS count FROM pages WHERE document_id = $1', [doc.id]);
    assert.equal(stored.rows[0]?.count, 0, `${code} stores no pages`);
    await endOpenDocuments(pool);
  }
});

test('three internal errors from the parser end the document FAILED, the first two leave it at PARSE', async () => {
  fake.behave(async () => ({ ok: false, code: 'INTERNAL_ERROR', params: { cause: 'job_deadline' } }));
  const doc = await addDocument(pool);
  await mkdir(path.dirname(path.join(blobRoot, blobKeyOf(doc.sha256))), { recursive: true });
  await writeFile(path.join(blobRoot, blobKeyOf(doc.sha256)), 'original bytes');
  const statuses: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimNext(pool, claimOptions);
    assert.equal(claimed?.document.id, doc.id);
    assert.ok(claimed);
    await step(claimed);
    statuses.push((await stateOf(pool, doc.id)).status);
  }
  assert.deepEqual(statuses, ['PARSE', 'PARSE', 'FAILED']);
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => [reason.code, reason.params['cause'], reason.attempt]), [
    ['INTERNAL_ERROR', 'job_deadline', 1],
    ['INTERNAL_ERROR', 'job_deadline', 2],
    ['INTERNAL_ERROR', 'job_deadline', 3],
  ]);
});

test('an output that breaks the safe-read rules makes the step throw, and the failure maps to an internal error', async () => {
  fake.behave(async (jobId, outDir) => {
    await writeOutput(jobId, outDir, [{ entry: pageEntry(1, 'text_layer'), text: readable }]);
    const { rm } = await import('node:fs/promises');
    await rm(path.join(outDir, 'page-1.png'));
    await symlink('/etc/hostname', path.join(outDir, 'page-1.png'));
    return { ok: true };
  });
  const { doc, claimed } = await claimedDocument();
  await assert.rejects(step(claimed), UnsafeOutputError);
  assert.equal((await pool.query('SELECT count(*) AS count FROM pages WHERE document_id = $1', [doc.id])).rows[0].count, 0, 'nothing of it was stored');
  const settled = await recordFailure(pool, claimed, failureOf(new UnsafeOutputError('x')), {});
  assert.equal(settled, 'PARSE');
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => reason.params), [{ cause: 'unsafe_output' }]);
});

test('an unreachable parser makes the step throw a connect error', async () => {
  const lonely = await mkdtemp(path.join(tmpdir(), 'no-parser-'));
  await mkdir(path.join(lonely, 'in'));
  await mkdir(path.join(lonely, 'out'));
  const withoutParser = createParseStep({ pool, thresholds: config.thresholds, validateManifest: validators.parserManifest, jobsDir: lonely, blobRoot, logger: quiet });
  const { claimed } = await claimedDocument();
  await assert.rejects(withoutParser(claimed), (error: unknown) => error instanceof ParserClientError && error.kind === 'connect');
});
