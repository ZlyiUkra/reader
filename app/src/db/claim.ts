import type pg from 'pg';
import { isReasonCode } from '../reasons/reasons.ts';
import { currentStep, status, stepStatuses } from '../reasons/status.ts';
import { completeStepRun, insertReason, insertStepRun, reasonsOf } from './queries.ts';
import type { DocumentRow } from './queries.ts';
import { withTransaction } from './tx.ts';
import type { Queryable } from './tx.ts';

/**
 * The queue: claiming a step of a document, finishing it, and recovering what a dead worker left behind (FR-030, FR-031,
 * data-model.md, State machine). The status table is the only queue (constitution III); a claim is a row lock that lasts
 * one short transaction, and the work itself runs outside it, so no lock is held while a tool or the model is busy
 * (FR-023). The lease on the row is what tells a later pass that a worker died.
 */

/** The steps of the pipeline, in order. Each document waits for one of them or has ended. */
export const steps = ['parse', 'classify', 'extract', 'check'] as const;

/** One step of the pipeline. */
export type Step = (typeof steps)[number];

/** The step a document waits for or is in, from its status; `RECEIVED` waits for the first step. */
const stepOfStatus: Record<string, Step> = {
  [stepStatuses.RECEIVED]: 'parse',
  [stepStatuses.PARSE]: 'parse',
  [stepStatuses.CLASSIFY]: 'classify',
  [stepStatuses.EXTRACT]: 'extract',
  [stepStatuses.CHECK]: 'check',
};

/** The status a document holds while a step runs, and while it waits for a retry of that step. */
export const statusOfStep: Record<Step, string> = {
  parse: stepStatuses.PARSE,
  classify: stepStatuses.CLASSIFY,
  extract: stepStatuses.EXTRACT,
  check: stepStatuses.CHECK,
};

/** The statuses from which a step can be claimed: its own, and for the first step also `RECEIVED`. */
function claimableStatuses(step: Step): string[] {
  return step === 'parse' ? [stepStatuses.RECEIVED, stepStatuses.PARSE] : [statusOfStep[step]];
}

/** The statuses in which a document can hold a lease. */
const inFlightStatuses = Object.values(statusOfStep);

/** The step a status stands for; a terminal status stands for none. */
export function stepOf(documentStatus: string): Step | null {
  return stepOfStatus[documentStatus] ?? null;
}

/** What a claim hands to the worker. */
export type Claimed = {
  document: DocumentRow;
  step: Step;
  stepRunId: number;
  /** The value of `documents.attempts` after this claim. */
  attempt: number;
};

/** Which steps may be claimed now, how long the lease is for each, and who claims. */
export type ClaimOptions = {
  steps: Step[];
  leaseSeconds: (step: Step) => number;
  instanceId: string;
};

/**
 * Claims the oldest document that waits for one of the wanted steps and has no live lease: `SELECT … FOR UPDATE SKIP LOCKED`,
 * then the status becomes the step's, `attempts` grows by one, the lease is set to now plus the step's lease, and the
 * attempt's `step_runs` row is inserted, all in one transaction (FR-031). Returns null when nothing is waiting.
 */
export async function claimNext(pool: pg.Pool, options: ClaimOptions): Promise<Claimed | null> {
  const wanted = options.steps.flatMap(claimableStatuses);
  if (wanted.length === 0) {
    return null;
  }
  return withTransaction(pool, async (client) => {
    const picked = await client.query<{ id: number; status: string }>(
      `SELECT id, status FROM documents
       WHERE status = ANY($1::text[]) AND (locked_until IS NULL OR locked_until < now())
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [wanted],
    );
    const row = picked.rows[0];
    const step = row === undefined ? null : stepOf(row.status);
    if (row === undefined || step === null) {
      return null;
    }
    const updated = await client.query<DocumentRow>(
      `UPDATE documents
       SET status = $2, attempts = attempts + 1, locked_until = now() + make_interval(secs => $3), locked_by = $4, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id, statusOfStep[step], options.leaseSeconds(step), options.instanceId],
    );
    const document = updated.rows[0];
    if (document === undefined) {
      return null;
    }
    const stepRunId = await insertStepRun(client, document.id, step, document.attempts);
    return { document, step, stepRunId, attempt: document.attempts };
  });
}

/**
 * The attempt ended after its lease did, so another path has already recorded its end (the lease recovery) and the step
 * that thought it was still running must not commit anything. The transaction that raised this is rolled back.
 */
export class LeaseLostError extends Error {
  constructor(documentId: number, step: Step) {
    super(`The lease of document ${documentId} on step ${step} expired before the step finished`);
    this.name = 'LeaseLostError';
  }
}

/**
 * Moves a document to the status its reasons give (the one status function, FR-026) and releases its lease. When the
 * reasons do not end the document, it takes `statusWhenOpen`: the next step after a success, the same step for a retry.
 */
export async function settleDocument(db: Queryable, documentId: number, statusWhenOpen: string): Promise<string> {
  const document = await db.query<{ attempts: number; checks_done: boolean }>('SELECT attempts, checks_done FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
  const row = document.rows[0];
  if (row === undefined) {
    throw new Error(`Document ${documentId} does not exist`);
  }
  const reasons = (await reasonsOf(db, documentId)).map((reason) => {
    if (!isReasonCode(reason.code)) {
      throw new Error(`Document ${documentId} carries the unknown reason code ${reason.code}`);
    }
    return { code: reason.code, attempt: reason.attempt };
  });
  const verdict = status(reasons, row.attempts, row.checks_done);
  const next = verdict === currentStep ? statusWhenOpen : verdict;
  await db.query('UPDATE documents SET status = $2, locked_until = NULL, locked_by = NULL, updated_at = now() WHERE id = $1', [documentId, next]);
  return next;
}

/** How an attempt ended, as recorded in `step_runs.outcome`. */
export type StepOutcome = 'ok' | 'reason' | 'internal_error';

/** What ends an attempt. */
export type FinishArgs = {
  documentId: number;
  stepRunId: number;
  step: Step;
  outcome: StepOutcome;
  /** Tool timings and counts for the detail view; never document text. */
  details: object;
  /** The status the document takes when its reasons do not end it. */
  statusWhenOpen: string;
};

/**
 * Ends an attempt inside the transaction that holds its output (FR-030): the `step_runs` row is completed and the document
 * takes the status its reasons give. Returns the new status. If the attempt was already ended by the lease recovery the
 * output must not be committed, so this throws `LeaseLostError` and the caller's transaction rolls back.
 */
export async function finishStep(db: Queryable, args: FinishArgs): Promise<string> {
  if (!(await completeStepRun(db, args.stepRunId, args.outcome, args.details))) {
    throw new LeaseLostError(args.documentId, args.step);
  }
  return settleDocument(db, args.documentId, args.statusWhenOpen);
}

/**
 * Finds every document whose lease has run out and records it as the end of that attempt: the open `step_runs` row gets the
 * outcome `lease_expired`, the reason `INTERNAL_ERROR {cause: "lease_expired"}` is added for that attempt, and the document
 * takes the status the reasons give (the same step, or FAILED at the third attempt). The expiry counts as the attempt
 * that was running (FR-031). Returns how many documents were recovered.
 */
export async function recoverExpiredLeases(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const expired = await client.query<{ id: number; status: string; attempts: number }>(
      `SELECT id, status, attempts FROM documents
       WHERE status = ANY($1::text[]) AND locked_until < now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED`,
      [inFlightStatuses],
    );
    for (const row of expired.rows) {
      const step = stepOf(row.status) ?? 'parse';
      const open = await client.query<{ id: number }>(
        'SELECT id FROM step_runs WHERE document_id = $1 AND attempt = $2 AND finished_at IS NULL ORDER BY id DESC LIMIT 1',
        [row.id, row.attempts],
      );
      const stepRunId = open.rows[0]?.id;
      if (stepRunId !== undefined) {
        await completeStepRun(client, stepRunId, 'lease_expired', { cause: 'lease_expired' });
      }
      await insertReason(client, { documentId: row.id, code: 'INTERNAL_ERROR', params: { cause: 'lease_expired' }, step, attempt: row.attempts });
      await settleDocument(client, row.id, row.status);
    }
    return expired.rows.length;
  });
}

/**
 * The boot requeue (named simplification, FR-031): on start the single worker releases the rows it left in flight, those
 * locked by its own instance id, so they are claimed again at once instead of after their lease. The dead attempt's
 * `step_runs` row is left open and the next claim counts as a new attempt. Returns how many documents were released.
 */
export async function requeueOwn(pool: pg.Pool, instanceId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE documents SET locked_until = NULL, locked_by = NULL, updated_at = now()
     WHERE locked_by = $1 AND status = ANY($2::text[])`,
    [instanceId, inFlightStatuses],
  );
  return result.rowCount ?? 0;
}
