import type pg from 'pg';
import { thresholdSnapshot } from '../config/thresholds.ts';
import type { ThresholdsFile } from '../config/types.ts';
import { finishStep } from '../db/claim.ts';
import type { Claimed } from '../db/claim.ts';
import { insertExtraction, insertReason } from '../db/queries.ts';
import type { NewExtraction } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import type { LlmKind, LlmPort, LlmResponse } from '../llm/port.ts';
import type { ModelSettings } from '../llm/settings.ts';
import type { Prompt } from '../registry/prompt.ts';
import type { Registry } from '../registry/registry.ts';
import { wireSchemaHash } from '../registry/wire.ts';
import type { WireSchema } from '../registry/wire.ts';
import type { Logger } from '../shared/logger.ts';
import { leaseSeconds } from './lease.ts';

/**
 * What the two model steps share (classify and extract): one call through the LLM port, the row that records it
 * (FR-032), and the one outcome both can meet that is not an error, a generation cut off at its cap (FR-022). The steps
 * differ in the prompt, the schema and what they do with the answer; everything around the call is the same, so it
 * lives once.
 */

/** What a model step is built from. */
export type ModelStepDeps = {
  pool: pg.Pool;
  /** The dispatcher in production, the replay adapter behind a dispatcher in the tests: the port the pipeline may import. */
  port: LlmPort;
  /** Stored as `extractions.adapter`: the port does not say which adapter is behind it. */
  adapterName: string;
  registry: Registry;
  thresholds: ThresholdsFile;
  settings: ModelSettings;
  logger: Logger;
};

/** Narrows an unknown JSON value to an object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A model reply that passed the wire schema but is not what the step can use, or a stored reply the check step cannot read
 * back. It is a defect of the data and not of the document, so it is an `INTERNAL_ERROR`, retried like any other (C6).
 */
export class ModelReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelReplyError';
  }
}

/**
 * Asks the model once. The call may not outlive the step's lease: the adapter has its own timeout per request and tries
 * up to three, so the lease is built from them and this signal is the outer bound that ends a call that would otherwise
 * run into a second worker's claim. A refused or failed call throws; the worker turns the error into a reason (C6).
 */
export async function askModel(deps: ModelStepDeps, claimed: Claimed, kind: LlmKind, prompt: Prompt, wire: WireSchema): Promise<LlmResponse> {
  return deps.port.call(
    {
      kind,
      documentNumber: claimed.document.id,
      class: claimed.document.class,
      system: prompt.system,
      user: prompt.user,
      wireSchema: wire,
      numPredict: deps.settings.numPredict[kind],
    },
    AbortSignal.timeout(leaseSeconds(claimed.step, deps.thresholds) * 1000),
  );
}

/** The row that records one model call: the identity, the hashes, what was sent and what came back, the counts and the numbers in force (FR-032, C13). */
export function newExtraction(
  deps: ModelStepDeps,
  claimed: Claimed,
  kind: LlmKind,
  schemaId: string | null,
  prompt: Prompt,
  wire: WireSchema,
  response: LlmResponse,
): NewExtraction {
  return {
    documentId: claimed.document.id,
    kind,
    attempt: claimed.attempt,
    adapter: deps.adapterName,
    modelName: response.modelName,
    modelDigest: response.modelDigest,
    schemaId,
    registryHash: deps.registry.hash,
    promptHash: prompt.hash,
    wireSchemaHash: wireSchemaHash(wire),
    rawRequest: response.raw.request,
    rawResponse: response.raw.response,
    doneReason: response.doneReason,
    loadDurationNs: response.durationsNs.load,
    promptEvalCount: response.counts.promptEval,
    promptEvalDurationNs: response.durationsNs.promptEval,
    evalCount: response.counts.eval,
    evalDurationNs: response.durationsNs.eval,
    totalDurationNs: response.durationsNs.total,
    cold: response.cold,
    thresholds: thresholdSnapshot(deps.thresholds, ['model.']),
  };
}

/** What the detail view shows about a model call: counts, durations and whether the model was warm; never text. */
export function callDetails(extractionId: number, response: LlmResponse, modelMs: number): object {
  return {
    extractionId,
    modelMs,
    cold: response.cold,
    doneReason: response.doneReason,
    promptEvalCount: response.counts.promptEval,
    evalCount: response.counts.eval,
  };
}

/**
 * Ends the document after a generation that stopped at its cap (FR-022, C7): the call is stored as it was, the reason
 * is `TOO_LARGE` with the cap named as the breached limit, and the status function makes it REJECTED. It is not retried,
 * because the same prompt would hit the same cap, so the step ends here without an error.
 */
export async function endAtGenerationCap(
  deps: ModelStepDeps,
  claimed: Claimed,
  extraction: NewExtraction,
  response: LlmResponse,
  modelMs: number,
): Promise<string> {
  const cap = deps.settings.numPredict[extraction.kind];
  return withTransaction(deps.pool, async (client) => {
    const extractionId = await insertExtraction(client, extraction);
    await insertReason(client, {
      documentId: claimed.document.id,
      code: 'TOO_LARGE',
      params: { limit: 'num_predict', actual: response.counts.eval ?? cap, max: cap },
      step: claimed.step,
      attempt: claimed.attempt,
    });
    return finishStep(client, {
      documentId: claimed.document.id,
      stepRunId: claimed.stepRunId,
      step: claimed.step,
      outcome: 'reason',
      details: callDetails(extractionId, response, modelMs),
      statusWhenOpen: claimed.document.status,
    });
  });
}
