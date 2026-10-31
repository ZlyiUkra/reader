import type pg from 'pg';
import { LeaseLostError, finishStep } from '../db/claim.ts';
import type { Claimed, StepOutcome } from '../db/claim.ts';
import { insertReason } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import { ParserClientError } from '../parser-client/client.ts';
import type { ParserAnswer } from '../parser-client/client.ts';
import { LlmAdapterError, LocalOnlyViolation, PromptOverBudget } from '../llm/port.ts';
import { UnsafeOutputError } from '../parser-client/safe-read.ts';
import { reasonCodes } from '../reasons/reasons.ts';
import type { ReasonCode } from '../reasons/reasons.ts';
import { ModelReplyError } from './model-call.ts';

/**
 * How a failure becomes a reason (C6, FR-027). The rule is one table: a tool over its own limit on a file ends the document
 * `TOO_LARGE` without retry; a tool error caused by the file ends it `CORRUPT`; anything that is not the file's fault, an
 * unreachable parser, a timeout, an output that breaks the safe-read rules, a defect, is `INTERNAL_ERROR`, which the status
 * function retries until the third attempt and then calls FAILED. The parser has already told the first two apart
 * (contracts/parser.md), so they arrive as an answer and not as an error; this module maps what the app itself can throw.
 */

/** A reason to store: a code and its named parameters. */
export type Failure = {
  code: ReasonCode;
  params: Record<string, string | number>;
};

/**
 * Maps an error thrown by a step to the reason it leaves on the document. Nothing is swallowed: an unknown error is still
 * recorded. A prompt that does not fit the context is the document's own size and ends it `TOO_LARGE` without a retry
 * (FR-022); a model server that fails, a reply that stays invalid and a refused class are infrastructure and are retried.
 */
export function failureOf(error: unknown): Failure {
  if (error instanceof PromptOverBudget) {
    return { code: 'TOO_LARGE', params: { limit: 'prompt_tokens', actual: error.estimatedTokens, max: error.availableTokens } };
  }
  if (error instanceof LlmAdapterError) {
    return { code: 'INTERNAL_ERROR', params: { cause: `model_${error.kind.replaceAll('-', '_')}` } };
  }
  if (error instanceof LocalOnlyViolation) {
    return { code: 'INTERNAL_ERROR', params: { cause: 'local_only' } };
  }
  if (error instanceof ModelReplyError) {
    return { code: 'INTERNAL_ERROR', params: { cause: 'model_reply' } };
  }
  if (error instanceof ParserClientError) {
    return { code: 'INTERNAL_ERROR', params: { cause: `parser_${error.kind}` } };
  }
  if (error instanceof UnsafeOutputError) {
    return { code: 'INTERNAL_ERROR', params: { cause: 'unsafe_output' } };
  }
  return { code: 'INTERNAL_ERROR', params: { cause: 'unexpected' } };
}

/** Maps a reason the parser reported to the reason stored: the parser's own four, or its internal error with a cause. */
export function failureOfParserAnswer(answer: Extract<ParserAnswer, { ok: false }>): Failure {
  if (answer.code === 'INTERNAL_ERROR') {
    return { code: 'INTERNAL_ERROR', params: { cause: typeof answer.params['cause'] === 'string' ? answer.params['cause'] : 'parser' } };
  }
  return { code: answer.code, params: answer.params };
}

/** The outcome recorded in `step_runs` for a reason: a retried failure is `internal_error`, any other reason is `reason`. */
export function outcomeOfFailure(failure: Failure): StepOutcome {
  return reasonCodes[failure.code] === 'RETRY' ? 'internal_error' : 'reason';
}

/**
 * Ends an attempt with a reason, in one transaction: the reason is stored for this attempt, the `step_runs` row is
 * completed and the document takes the status the reasons give (REJECTED, FAILED at the third attempt, or the same step to
 * be tried again). Returns the new status, or null if the lease had already been taken away, in which case nothing is
 * committed and the recovery has recorded the attempt.
 */
export async function recordFailure(pool: pg.Pool, claimed: Claimed, failure: Failure, details: object): Promise<string | null> {
  try {
    return await withTransaction(pool, async (client) => {
      await insertReason(client, { documentId: claimed.document.id, code: failure.code, params: failure.params, step: claimed.step, attempt: claimed.attempt });
      return finishStep(client, {
        documentId: claimed.document.id,
        stepRunId: claimed.stepRunId,
        step: claimed.step,
        outcome: outcomeOfFailure(failure),
        details: { ...details, code: failure.code },
        statusWhenOpen: claimed.document.status,
      });
    });
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return null;
    }
    throw error;
  }
}
