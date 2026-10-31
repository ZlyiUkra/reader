import { finishStep } from '../db/claim.ts';
import { insertExtraction, pageReadingsOf } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import { stepStatuses } from '../reasons/status.ts';
import { extractPrompt } from '../registry/prompt.ts';
import { wireSchema } from '../registry/wire.ts';
import type { StepHandler } from '../worker.ts';
import { askModel, callDetails, endAtGenerationCap, isRecord, ModelReplyError, newExtraction } from './model-call.ts';
import type { ModelStepDeps } from './model-call.ts';

/**
 * The extract step (FR-017, FR-022): one model call asks for every field of the detected type, each as the exact quoted
 * fragment and its page. The prompt and the request schema are functions of the registry type, so nothing about a type is
 * written here. The prompt is checked against the context budget before it is sent (the dispatcher does it, and an
 * over-budget prompt ends the document `TOO_LARGE`); a generation that stops at its cap ends the document `TOO_LARGE` with
 * the cap as the breached limit and is not retried. This step only records what the model said, with the numbers in force;
 * locating the fragments and deriving the values is the check step's work on the stored reply (FR-018, constitution V).
 */

/** Builds the handler of the extract step. */
export function createExtractStep(deps: ModelStepDeps): StepHandler {
  return async (claimed) => {
    const { document } = claimed;
    const type = document.doc_type === null ? undefined : deps.registry.byName.get(document.doc_type);
    if (type === undefined) {
      throw new ModelReplyError(`Document ${document.id} reached the extract step with the type "${document.doc_type ?? ''}", which is not in the registry.`);
    }
    const readings = await pageReadingsOf(deps.pool, document.id);
    if (readings.length === 0) {
      throw new ModelReplyError(`Document ${document.id} reached the extract step without a page text.`);
    }
    const wire = wireSchema(type);
    const prompt = extractPrompt(
      type,
      readings.map((reading) => reading.text),
    );

    const started = performance.now();
    const response = await askModel(deps, claimed, 'extract', prompt, wire);
    const modelMs = Math.round(performance.now() - started);
    const extraction = newExtraction(deps, claimed, 'extract', type.schemaId, prompt, wire, response);

    if (response.doneReason === 'length') {
      const status = await endAtGenerationCap(deps, claimed, extraction, response, modelMs);
      deps.logger.info({ document: document.id, attempt: claimed.attempt, status, modelMs }, 'The extraction hit the generation cap.');
      return;
    }
    if (!isRecord(response.json)) {
      throw new ModelReplyError('The extraction reply is not an object.');
    }

    const status = await withTransaction(deps.pool, async (client) => {
      const extractionId = await insertExtraction(client, extraction);
      return finishStep(client, {
        documentId: document.id,
        stepRunId: claimed.stepRunId,
        step: claimed.step,
        outcome: 'ok',
        details: callDetails(extractionId, response, modelMs),
        statusWhenOpen: stepStatuses.CHECK,
      });
    });
    deps.logger.info({ document: document.id, attempt: claimed.attempt, type: type.name, status, modelMs, cold: response.cold }, 'The extract step finished.');
  };
}
