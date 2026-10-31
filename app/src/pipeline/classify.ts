import { finishStep } from '../db/claim.ts';
import { insertExtraction, insertReason, pageReadingsOf, setDocType } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import { classifyPrompt } from '../registry/prompt.ts';
import { classifySchema } from '../registry/wire.ts';
import { stepStatuses } from '../reasons/status.ts';
import type { StepHandler } from '../worker.ts';
import { askModel, callDetails, endAtGenerationCap, isRecord, ModelReplyError, newExtraction } from './model-call.ts';
import type { ModelStepDeps } from './model-call.ts';

/**
 * The classify step (FR-016): the page texts and the registered types go to the model, which names one type or `none`.
 * The list of types, the prompt and the request schema all come from the registry, so a new schema file is a new choice
 * on the next call with no change here (FR-043). The call is stored as it was, and the answer moves the document on in
 * the same transaction: a type sends it to extraction, `none` ends it NEEDS_REVIEW with `UNKNOWN_DOC_TYPE` and no field
 * rows. The model call itself runs outside any transaction and holds no row lock (FR-023).
 */

/** The type name in a classification reply, which the wire schema has already limited to the registry's names and `none`. */
function chosenType(json: unknown): string {
  if (!isRecord(json) || typeof json['type'] !== 'string') {
    throw new ModelReplyError('The classification reply has no type.');
  }
  return json['type'];
}

/** Builds the handler of the classify step. */
export function createClassifyStep(deps: ModelStepDeps): StepHandler {
  const wire = classifySchema(deps.registry.types.map((type) => type.name));

  return async (claimed) => {
    const { document } = claimed;
    const readings = await pageReadingsOf(deps.pool, document.id);
    if (readings.length === 0) {
      throw new ModelReplyError(`Document ${document.id} reached the classify step without a page text.`);
    }
    const prompt = classifyPrompt(
      deps.registry,
      readings.map((reading) => reading.text),
    );

    const started = performance.now();
    const response = await askModel(deps, claimed, 'classify', prompt, wire);
    const modelMs = Math.round(performance.now() - started);
    const extraction = newExtraction(deps, claimed, 'classify', null, prompt, wire, response);

    if (response.doneReason === 'length') {
      const status = await endAtGenerationCap(deps, claimed, extraction, response, modelMs);
      deps.logger.info({ document: document.id, attempt: claimed.attempt, status, modelMs }, 'The classification hit the generation cap.');
      return;
    }

    const chosen = chosenType(response.json);
    const type = chosen === 'none' ? null : deps.registry.byName.get(chosen);
    if (type === undefined) {
      throw new ModelReplyError(`The classification reply names "${chosen}", which is not in the registry.`);
    }

    const status = await withTransaction(deps.pool, async (client) => {
      const extractionId = await insertExtraction(client, extraction);
      if (type === null) {
        await insertReason(client, { documentId: document.id, code: 'UNKNOWN_DOC_TYPE', params: {}, step: claimed.step, attempt: claimed.attempt });
      } else {
        await setDocType(client, document.id, type.name, type.schemaId);
      }
      return finishStep(client, {
        documentId: document.id,
        stepRunId: claimed.stepRunId,
        step: claimed.step,
        outcome: type === null ? 'reason' : 'ok',
        details: { ...callDetails(extractionId, response, modelMs), type: chosen },
        statusWhenOpen: stepStatuses.EXTRACT,
      });
    });
    deps.logger.info({ document: document.id, attempt: claimed.attempt, type: chosen, status, modelMs, cold: response.cold }, 'The classify step finished.');
  };
}
