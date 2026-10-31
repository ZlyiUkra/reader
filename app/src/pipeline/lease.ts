import type { Step } from '../db/claim.ts';
import type { ThresholdsFile } from '../config/types.ts';
import { jobDeadlineMs, parserTimeouts } from '../parser-client/client.ts';
import { thresholdNumber } from '../config/thresholds.ts';

/**
 * How long a claim holds a document before another pass may take it over (FR-031, research R14): the sum of the step's own
 * timeouts, so a lease never runs out under a step that is still within its limits. There is no heartbeat in the prototype
 * (named simplification), so a lease that is too short would hand a live step to a second worker, and one that is too
 * long only delays the recovery of a dead one.
 */

/** Seconds added to the step's own timeouts for the database work around the call. */
const databaseSlackSeconds = 30;

/**
 * How many requests one model call may send: chat without thinking, then generate, then chat with thinking (C4). Each has
 * the client timeout, so the worst case of a call is this many timeouts.
 */
const modelRequestsPerCall = 3;

/**
 * The lease of a step in seconds. The parse step may take as long as the client waits for the parser (the conversion plus,
 * per page, two renders and an OCR, with the parser's own slack). A model step may take every request of the adapter's
 * fallbacks to its client timeout. The check step only reads and writes the database. Each adds a margin for the database
 * work around it.
 */
export function leaseSeconds(step: Step, thresholds: ThresholdsFile): number {
  switch (step) {
    case 'parse':
      return Math.ceil(jobDeadlineMs(parserTimeouts(thresholds)) / 1000) + databaseSlackSeconds;
    case 'classify':
    case 'extract':
      return modelRequestsPerCall * thresholdNumber(thresholds, 'model.client_timeout_s') + databaseSlackSeconds;
    case 'check':
      return databaseSlackSeconds;
  }
}
