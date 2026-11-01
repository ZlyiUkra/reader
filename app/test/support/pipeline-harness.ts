import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type pg from 'pg';
import type { ParserManifest, ThresholdsFile } from '../../src/config/types.ts';
import { insertPage, insertPageText, reasonsOf, setDetectedMime } from '../../src/db/queries.ts';
import { withTransaction } from '../../src/db/tx.ts';
import { pageBlobKey } from '../../src/intake/store.ts';
import { createDispatcher } from '../../src/llm/dispatcher.ts';
import type { LlmAdapter } from '../../src/llm/port.ts';
import { createReplayAdapter, recordingFile } from '../../src/llm/replay.ts';
import type { ModelSettings } from '../../src/llm/settings.ts';
import { createCheckStep } from '../../src/pipeline/check.ts';
import { createClassifyStep } from '../../src/pipeline/classify.ts';
import { createExtractStep } from '../../src/pipeline/extract.ts';
import { leaseSeconds } from '../../src/pipeline/lease.ts';
import type { Registry } from '../../src/registry/registry.ts';
import type { ClassesFile } from '../../src/config/types.ts';
import { startWorker } from '../../src/worker.ts';
import type { Worker, WorkerLogger } from '../../src/worker.ts';
import { addDocument, stateOf } from './db.ts';

/**
 * What the replay test and the recording command share (T052): the eleven fixtures as the parser left them, put into the
 * database as documents that have just finished parsing, and the wait for the worker to bring them to a terminal status.
 * The parser outputs are the golden ones saved when slice 4 closed (`fixtures/golden/`), so the model steps work on the
 * very texts the real parser produced, and the model's replies are either recorded from the real model or replayed.
 */

/** The folder of the golden parser outputs: `<file>.manifest.json` and `<file>.page-<n>.txt` for each fixture. */
export const goldenDir = path.join(import.meta.dirname, '..', 'fixtures', 'golden');

/** The folder of the recorded model replies. */
export const replayDir = path.join(import.meta.dirname, '..', 'fixtures', 'replay');

/**
 * What the generator wrote as the expected result of each fixture (`inbox/expected/`): the status and the reason codes.
 * `measuredExtra` lists codes the real model was seen to add on top, which the evaluation will count as errors of the
 * model and not hide: the scanned invoice is a noisy OCR page on which the 4B model rewrites dates and picks the wrong
 * number for the VAT, and the pipeline rightly refuses to accept what it cannot find in the text or what fails the VAT rule.
 */
export const fixtureExpectations: Array<{ file: string; status: string; codes: string[]; measuredExtra?: string[] }> = [
  { file: 'act-1.png', status: 'ACCEPTED', codes: [] },
  { file: 'act-2.jpg', status: 'ACCEPTED', codes: [] },
  { file: 'act-3.rtf', status: 'NEEDS_REVIEW', codes: ['MISSING_REQUIRED_FIELD'] },
  { file: 'contract-1.svg', status: 'ACCEPTED', codes: [] },
  { file: 'contract-2.docx', status: 'ACCEPTED', codes: [] },
  { file: 'contract-3.doc', status: 'NEEDS_REVIEW', codes: ['MISSING_REQUIRED_FIELD'] },
  { file: 'invoice-1.pdf', status: 'ACCEPTED', codes: [] },
  { file: 'invoice-2.xlsx', status: 'ACCEPTED', codes: [] },
  { file: 'invoice-3-scan.pdf', status: 'NEEDS_REVIEW', codes: ['MISSING_REQUIRED_FIELD'], measuredExtra: ['VALIDATION_FAILED'] },
  { file: 'invoice-vat-error.pdf', status: 'NEEDS_REVIEW', codes: ['VALIDATION_FAILED'] },
  { file: 'letter-untyped.docx', status: 'NEEDS_REVIEW', codes: ['UNKNOWN_DOC_TYPE'] },
];

/** A fixture's golden manifest and the text of each of its pages. */
export async function goldenOf(file: string): Promise<{ manifest: ParserManifest; texts: string[] }> {
  const manifest = JSON.parse(await readFile(path.join(goldenDir, `${file}.manifest.json`), 'utf8')) as ParserManifest;
  const texts = await Promise.all(manifest.pages.map((page) => readFile(path.join(goldenDir, `${file}.page-${page.n}.txt`), 'utf8')));
  return { manifest, texts };
}

/**
 * Adds a document as it is when the parse step has just finished: the pages and their texts are stored and the status is
 * CLASSIFY. Its attempts are zero, because the count starts again for every step. The hash is a random one unless the fixture's
 * own is given, which the evaluation needs: it finds a document by the hash the generator wrote in `expected/`.
 */
export async function addParsedFixture(pool: pg.Pool, file: string, fixtureSha256?: string): Promise<number> {
  const { manifest, texts } = await goldenOf(file);
  const { id, sha256 } = await addDocument(pool, { originalName: file, documentClass: 'synthetic', ...(fixtureSha256 === undefined ? {} : { sha256: fixtureSha256 }) });
  await withTransaction(pool, async (client) => {
    await setDetectedMime(client, id, manifest.detectedMime);
    for (const page of manifest.pages) {
      const pageId = await insertPage(client, { documentId: id, pageNo: page.n, widthPx: page.widthPx, heightPx: page.heightPx, pngBlobKey: pageBlobKey(sha256, page.n) });
      await insertPageText(client, {
        pageId,
        source: page.source,
        engine: page.engine,
        engineVersion: page.engineVersion,
        dpi: page.dpi,
        text: texts[page.n - 1] ?? '',
        ocrWordsTotal: page.ocrWordsTotal,
        ocrWordsLow: page.ocrWordsLow,
        timings: page.timingsMs,
        thresholds: {},
      });
    }
    await client.query("UPDATE documents SET status = 'CLASSIFY' WHERE id = $1", [id]);
  });
  return id;
}

/** The statuses a document leaves when it is finished. */
const openStatuses = ['RECEIVED', 'PARSE', 'CLASSIFY', 'EXTRACT', 'CHECK'];

/** Waits until every document has a terminal status, or fails with the statuses it saw when the time ran out. */
export async function waitForTerminal(pool: pg.Pool, ids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all(ids.map(async (id) => ({ id, status: (await stateOf(pool, id)).status })));
    if (states.every((state) => !openStatuses.includes(state.status))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Not every document finished in ${timeoutMs} ms: ${JSON.stringify(states)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A document's status and the codes of its reasons, in the order they were written, for comparison with an expectation. */
export async function outcomeOf(pool: pg.Pool, id: number): Promise<{ status: string; codes: string[] }> {
  return { status: (await stateOf(pool, id)).status, codes: (await reasonsOf(pool, id)).map((reason) => reason.code) };
}

/** True when a document ended in the expected status with exactly the expected reason codes, plus the extra ones measured on the model. */
export function sameOutcome(expected: { status: string; codes: string[]; measuredExtra?: string[] }, got: { status: string; codes: string[] }): boolean {
  const wanted = [...new Set([...expected.codes, ...(expected.measuredExtra ?? [])])].sort();
  return got.status === expected.status && JSON.stringify([...new Set(got.codes)].sort()) === JSON.stringify(wanted);
}

/**
 * Wraps an adapter so that every reply it returns is also written to the recordings folder under the key the replay
 * adapter looks up (contracts/llm-port.md). It is the maintenance command's way to record: the same requests, the real model.
 */
export function recordingAdapter(inner: LlmAdapter, dir: string): LlmAdapter {
  return {
    name: inner.name,
    local: inner.local,
    readiness: () => inner.readiness(),
    async call(req, signal) {
      const response = await inner.call(req, signal);
      await mkdir(dir, { recursive: true });
      await writeFile(recordingFile(dir, req), `${JSON.stringify(response, null, 2)}\n`);
      return response;
    },
  };
}

/** The replay adapter over the recordings of the fixtures. */
export function fixtureReplay(): LlmAdapter {
  return createReplayAdapter(replayDir);
}

/** What the model steps and the worker are built from in a test or in the recording command. */
export type PipelineSetup = {
  pool: pg.Pool;
  adapter: LlmAdapter;
  classes: ClassesFile;
  registry: Registry;
  thresholds: ThresholdsFile;
  settings: ModelSettings;
  logger: WorkerLogger;
};

/**
 * Starts the real worker with the three steps that need no parser, behind the real dispatcher, over any adapter. The model
 * counts as ready, because the adapter in a test is the replay one, and the poll interval is short so a test does not wait.
 */
export function startPipeline(setup: PipelineSetup): Worker {
  const { pool, registry, thresholds, settings, logger } = setup;
  const port = createDispatcher({ adapter: setup.adapter, classes: setup.classes, settings, logger });
  const modelStepDeps = { pool, port, adapterName: setup.adapter.name, registry, thresholds, settings, logger };
  return startWorker({
    pool,
    handlers: { classify: createClassifyStep(modelStepDeps), extract: createExtractStep(modelStepDeps), check: createCheckStep({ pool, registry, logger }) },
    modelReady: async () => true,
    leaseSeconds: (step) => leaseSeconds(step, thresholds),
    instanceId: 'pipeline-test',
    pollIntervalMs: 50,
    logger,
  });
}
