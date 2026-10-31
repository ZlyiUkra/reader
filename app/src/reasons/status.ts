import { constants } from '../constants.ts';
import { outcomeOf } from './reasons.ts';
import type { ReasonCode } from './reasons.ts';

/**
 * The statuses a document holds while it is on its way: it waits for a step or is in it, and the name of the status is
 * the name of the step (data-model.md, state machine). `RECEIVED` is the status a document has until it is claimed.
 */
export const stepStatuses = {
  RECEIVED: 'RECEIVED',
  PARSE: 'PARSE',
  CLASSIFY: 'CLASSIFY',
  EXTRACT: 'EXTRACT',
  CHECK: 'CHECK',
} as const;

/**
 * The states a document can end a step in, as a closed list (constitution III, FR-026). `QUARANTINED` is reserved: no
 * code that leads to it is emitted in the prototype.
 */
export const terminalStatuses = {
  ACCEPTED: 'ACCEPTED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  QUARANTINED: 'QUARANTINED',
} as const;

/** One of the terminal statuses. */
export type TerminalStatus = keyof typeof terminalStatuses;

/**
 * The answer "the reasons do not end the document": it stays at the step it is at, pending for a retry or waiting for
 * the next step. The function takes no step, so it cannot name one; the caller keeps `documents.status` as it is.
 */
export const currentStep = 'CURRENT_STEP' as const;

/**
 * Every status the page can meet, in the order of a document's life. The reserved `QUARANTINED` is left out: nothing
 * emits it, and the list is what `GET /api/meta` hands to the page.
 */
export const documentStatuses = [...Object.keys(stepStatuses), 'ACCEPTED', 'NEEDS_REVIEW', 'REJECTED', 'FAILED'];

/** What `status()` answers: a terminal status, or `currentStep`. */
export type StatusResult = TerminalStatus | typeof currentStep;

/** A reason as the status function needs it: its code and the attempt that emitted it (data-model.md, `reasons`). */
export type StoredReason = {
  code: ReasonCode;
  attempt: number;
};

/**
 * The one function that turns a document's reasons into its status (FR-026, C1, constitution III). It follows the
 * outcome of each code, so the order of the first matching rule is the order of the specification:
 *
 * 1. a quarantine code gives QUARANTINED (reserved; the specification does not rank it, it is placed first so that a
 *    malware flag is never hidden by a rejection, and the table test pins that until a scanner exists);
 * 2. a rejection code gives REJECTED;
 * 3. INTERNAL_ERROR with `attempts` at the limit or above gives FAILED;
 * 4. INTERNAL_ERROR below the limit leaves the document at its step, to be requeued;
 * 5. a review code gives NEEDS_REVIEW;
 * 6. no reasons and the checks done gives ACCEPTED;
 * 7. otherwise the document stays at its step.
 *
 * An INTERNAL_ERROR counts only when it was emitted by the attempt now running; an older one belongs to a try that
 * has been replaced, and counting it would stop a document that has since recovered. Every other code counts whatever
 * its attempt. DUPLICATE is reported at intake and never stored, so it reaching this function is a bug: it throws.
 */
export function status(reasons: StoredReason[], attempts: number, checksDone: boolean): StatusResult {
  const counting = reasons.filter((reason) => reason.code !== 'INTERNAL_ERROR' || reason.attempt === attempts);
  const outcomes = new Set(counting.map((reason) => outcomeOf(reason.code)));

  if (outcomes.has('DUPLICATE')) {
    throw new Error('DUPLICATE is reported at intake and never reaches the status function');
  }
  if (outcomes.has('QUARANTINED')) {
    return terminalStatuses.QUARANTINED;
  }
  if (outcomes.has('REJECTED')) {
    return terminalStatuses.REJECTED;
  }
  if (outcomes.has('RETRY')) {
    return attempts >= constants.maxAttempts ? terminalStatuses.FAILED : currentStep;
  }
  if (outcomes.has('NEEDS_REVIEW')) {
    return terminalStatuses.NEEDS_REVIEW;
  }
  return counting.length === 0 && checksDone ? terminalStatuses.ACCEPTED : currentStep;
}
