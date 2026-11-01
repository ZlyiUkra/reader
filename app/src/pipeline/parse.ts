import { randomBytes } from 'node:crypto';
import { constants, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path/posix';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type pg from 'pg';
import { thresholdNumber, thresholdSnapshot } from '../config/thresholds.ts';
import type { ParserManifest, ThresholdsFile } from '../config/types.ts';
import { finishStep } from '../db/claim.ts';
import { insertPage, insertPageText, insertReason, setDetectedMime } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import { pageBlobKey, writeBlobIfAbsent } from '../intake/store.ts';
import { parserSocketPath, parserTimeouts, requestParse } from '../parser-client/client.ts';
import { prepareOutDir, readParserOutput } from '../parser-client/safe-read.ts';
import type { SafeReadLimits } from '../parser-client/safe-read.ts';
import { stepStatuses } from '../reasons/status.ts';
import type { Logger } from '../shared/logger.ts';
import type { StepHandler } from '../worker.ts';
import { failureOfParserAnswer, recordFailure } from './failures.ts';
import { readingReasons } from './quality.ts';
import type { QualityRules } from './quality.ts';

/**
 * The parse step (FR-009 to FR-014, FR-030): the original is copied into the parser's input folder under a fresh job id,
 * the parser is asked to read it, and what it wrote is read back only through the safe reader. The pages, their texts, the
 * reasons the readings call for, the end of the attempt and the new status commit in one transaction. Nothing here opens
 * document bytes: that is the sandbox's job (constitution VII).
 */

/** What the step needs. */
export type ParseStepDeps = {
  pool: pg.Pool;
  thresholds: ThresholdsFile;
  validateManifest: ValidateFunction<ParserManifest>;
  /** The jobs volume: `in/`, `out/` and the parser's socket. */
  jobsDir: string;
  /** The root of the blob store, for the original and the page previews. */
  blobRoot: string;
  logger: Logger;
};

/** The caps the safe reader holds the parser's output to, from the thresholds file. */
function safeReadLimits(thresholds: ThresholdsFile): SafeReadLimits {
  return {
    manifestMaxBytes: thresholdNumber(thresholds, 'parser.manifest_max_bytes'),
    pngMaxBytes: thresholdNumber(thresholds, 'parser.png_max_bytes'),
    textMaxBytes: thresholdNumber(thresholds, 'parser.text_max_bytes'),
    pngMaxSidePx: thresholdNumber(thresholds, 'parser.png_max_side_px'),
  };
}

/** The numbers of the two quality rules, from the thresholds file. */
function qualityRules(thresholds: ThresholdsFile): QualityRules {
  return {
    emptyMinChars: thresholdNumber(thresholds, 'quality.empty_min_chars'),
    ocrLowShare: thresholdNumber(thresholds, 'quality.ocr_low_share'),
    ocrLowConfidence: thresholdNumber(thresholds, 'quality.ocr_low_confidence'),
  };
}

/** PostgreSQL text cannot hold a NUL; a text layer may, so it is dropped rather than failing the document forever. */
function withoutNul(text: string): string {
  return text.replaceAll('\u0000', '');
}

/** Builds the handler of the parse step. */
export function createParseStep(deps: ParseStepDeps): StepHandler {
  const timeouts = parserTimeouts(deps.thresholds);
  const readLimits = safeReadLimits(deps.thresholds);
  const rules = qualityRules(deps.thresholds);
  const snapshot = thresholdSnapshot(deps.thresholds, ['parser.', 'quality.']);

  return async (claimed) => {
    const { document } = claimed;
    const started = performance.now();
    const jobId = randomBytes(16).toString('hex');

    // The app's only deletion: it empties the job's own output folder before dispatch (C8); `prepareOutDir` does it.
    const outDir = await prepareOutDir(path.join(deps.jobsDir, 'out'), jobId);
    const inDir = path.join(deps.jobsDir, 'in', jobId);
    await mkdir(inDir);
    await copyFile(path.join(deps.blobRoot, document.blob_key), path.join(inDir, 'input'), constants.COPYFILE_EXCL);

    const answer = await requestParse({ socketPath: parserSocketPath(deps.jobsDir), jobId, timeouts });
    const parserMs = Math.round(performance.now() - started);
    if (!answer.ok) {
      await recordFailure(deps.pool, claimed, failureOfParserAnswer(answer), { jobId, parserMs });
      return;
    }

    const output = await readParserOutput(outDir, jobId, deps.validateManifest, readLimits);
    const reasons = readingReasons(
      output.pages.map((page) => ({ text: page.text, source: page.entry.source, ocrWordsTotal: page.entry.ocrWordsTotal, ocrWordsLow: page.entry.ocrWordsLow })),
      rules,
    );
    for (const page of output.pages) {
      await writeBlobIfAbsent(deps.blobRoot, pageBlobKey(document.sha256, page.n), page.png);
    }

    const status = await withTransaction(deps.pool, async (client) => {
      await setDetectedMime(client, document.id, output.manifest.detectedMime);
      for (const page of output.pages) {
        const pageId = await insertPage(client, {
          documentId: document.id,
          pageNo: page.n,
          widthPx: page.entry.widthPx,
          heightPx: page.entry.heightPx,
          pngBlobKey: pageBlobKey(document.sha256, page.n),
        });
        await insertPageText(client, {
          pageId,
          source: page.entry.source,
          engine: page.entry.engine,
          engineVersion: page.entry.engineVersion,
          dpi: page.entry.dpi,
          text: withoutNul(page.text),
          ocrWordsTotal: page.entry.ocrWordsTotal,
          ocrWordsLow: page.entry.ocrWordsLow,
          timings: page.entry.timingsMs,
          thresholds: snapshot,
        });
      }
      for (const reason of reasons) {
        await insertReason(client, { documentId: document.id, code: reason.code, params: reason.params, step: claimed.step, attempt: claimed.attempt });
      }
      return finishStep(client, {
        documentId: document.id,
        stepRunId: claimed.stepRunId,
        step: claimed.step,
        outcome: reasons.length > 0 ? 'reason' : 'ok',
        details: {
          jobId,
          parserMs,
          pageCount: output.manifest.pageCount,
          detectedMime: output.manifest.detectedMime,
          converter: output.manifest.converter,
          timingsMs: output.manifest.timingsMs,
          limitsHit: output.manifest.limitsHit,
        },
        statusWhenOpen: stepStatuses.CLASSIFY,
      });
    });
    deps.logger.info({ document: document.id, attempt: claimed.attempt, status, pages: output.manifest.pageCount, parserMs }, 'The parse step finished.');
  };
}
