import type { Step } from '../db/claim.ts';
import type { ThresholdsFile } from '../config/types.ts';
import { jobDeadlineMs, parserTimeouts } from '../parser-client/client.ts';

/**
 * How long a claim holds a document before another pass may take it over (FR-031, research R14): the sum of the step's own
 * timeouts, so a lease never runs out under a step that is still within its limits. There is no heartbeat in the prototype
 * (named simplification), so a lease that is too short would hand a live step to a second worker, and one that is too
 * long only delays the recovery of a dead one.
 */

/** Seconds added to the parser's own deadline for the database work around the call. */
const parseLeaseSlackSeconds = 30;

/**
 * The lease of a step in seconds. The parse step may take as long as the client waits for the parser (the conversion plus,
 * per page, two renders and an OCR, with the parser's own slack), so the lease is that plus a margin for the database
 * work. The model steps get their lease with their handlers in a later slice; asking for one now is a defect.
 */
export function leaseSeconds(step: Step, thresholds: ThresholdsFile): number {
  if (step === 'parse') {
    return Math.ceil(jobDeadlineMs(parserTimeouts(thresholds)) / 1000) + parseLeaseSlackSeconds;
  }
  throw new Error(`No lease is defined for the step ${step}: it has no handler yet`);
}
