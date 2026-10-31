import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { LeaseLostError, claimNext, recoverExpiredLeases, requeueOwn } from './db/claim.ts';
import type { Claimed, Step } from './db/claim.ts';
import { failureOf, recordFailure } from './pipeline/failures.ts';
import type { Logger } from './shared/logger.ts';

/**
 * The single in-process worker (plan.md, FR-031, named simplification: one worker, boot requeue on top of the lease, no
 * heartbeat). It takes its own dependencies and never the web server, so splitting it into its own process later is a
 * wiring change (AGENTS.md). Its loop is: recover documents whose lease ran out, claim the oldest waiting step it has a
 * handler for, run it, repeat; when nothing waits it sleeps for the poll interval. The work of a step runs outside any
 * transaction that holds a row lock (FR-023); the claim and the finish are the short transactions around it.
 */

/** What a step does with a claimed document. It commits its own output together with the end of the attempt (FR-030). */
export type StepHandler = (claimed: Claimed) => Promise<void>;

/** The logger the worker needs: the two calls of the shared type plus `error`, which Fastify's logger has too. */
export type WorkerLogger = Logger & { error(fields: object, message: string): void };

/** What the worker is built from. */
export type WorkerDeps = {
  pool: pg.Pool;
  /** One handler per step that can run; a step without one is never claimed, so the documents wait for it. */
  handlers: Partial<Record<Step, StepHandler>>;
  /** True when the model is ready; the steps that call it are not claimed otherwise and no attempt is spent (C5, FR-037). */
  modelReady: () => Promise<boolean>;
  /** The lease of a step in seconds (FR-031). */
  leaseSeconds: (step: Step) => number;
  /** Stable across restarts of the same container, so the boot requeue finds what the previous run left in flight. */
  instanceId: string;
  /** How long to sleep when nothing waits, in milliseconds. */
  pollIntervalMs: number;
  logger: WorkerLogger;
};

/** A running worker. */
export type Worker = {
  /** Lets the current step finish, then ends the loop. There is no drain for a killed process (named simplification). */
  stop(): Promise<void>;
};

/** The steps that call the model and so wait while it is not ready. */
const modelSteps: Step[] = ['classify', 'extract'];

/** Starts the loop and returns at once. */
export function startWorker(deps: WorkerDeps): Worker {
  const stopper = new AbortController();
  const loop = run(deps, stopper.signal);
  return {
    async stop() {
      stopper.abort();
      await loop;
    },
  };
}

/** A short text for the log from anything that was thrown; never document content, only what our own code and the driver say. */
function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
}

/** The steps that may be claimed now: those with a handler, and the model steps only while the model is ready. */
async function claimableSteps(deps: WorkerDeps): Promise<Step[]> {
  const withHandler = (Object.keys(deps.handlers) as Step[]).filter((step) => deps.handlers[step] !== undefined);
  if (!withHandler.some((step) => modelSteps.includes(step)) || (await deps.modelReady())) {
    return withHandler;
  }
  return withHandler.filter((step) => !modelSteps.includes(step));
}

/** Runs one claimed step. A failure becomes a reason on the document (C6); a lost lease is only logged. */
async function runClaimed(deps: WorkerDeps, claimed: Claimed): Promise<void> {
  const handler = deps.handlers[claimed.step];
  const ids = { document: claimed.document.id, step: claimed.step, attempt: claimed.attempt };
  try {
    if (handler === undefined) {
      throw new Error(`No handler for the step ${claimed.step}`);
    }
    await handler(claimed);
  } catch (error) {
    if (error instanceof LeaseLostError) {
      deps.logger.warn(ids, 'The lease ran out before the step finished; its result was not stored.');
      return;
    }
    const failure = failureOf(error);
    deps.logger.error({ ...ids, cause: failure.params['cause'], error: describe(error) }, 'A step failed.');
    const settled = await recordFailure(deps.pool, claimed, failure, {});
    deps.logger.info({ ...ids, code: failure.code, status: settled }, 'The failure was recorded.');
  }
}

/** The loop. Any error in a pass is logged and the loop goes on, so a database that restarts does not end the worker. */
async function run(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  try {
    const released = await requeueOwn(deps.pool, deps.instanceId);
    if (released > 0) {
      deps.logger.warn({ released, instance: deps.instanceId }, 'Documents left in flight by the previous run were released.');
    }
  } catch (error) {
    deps.logger.error({ error: describe(error) }, 'The boot requeue failed; leases will recover the documents instead.');
  }
  while (!signal.aborted) {
    let worked = false;
    try {
      const recovered = await recoverExpiredLeases(deps.pool);
      if (recovered > 0) {
        deps.logger.warn({ recovered }, 'Documents whose lease ran out were recovered.');
      }
      const claimed = await claimNext(deps.pool, { steps: await claimableSteps(deps), leaseSeconds: deps.leaseSeconds, instanceId: deps.instanceId });
      if (claimed !== null) {
        worked = true;
        await runClaimed(deps, claimed);
      }
    } catch (error) {
      deps.logger.error({ error: describe(error) }, 'A pass of the worker failed; it will try again.');
    }
    if (!worked) {
      await sleep(deps.pollIntervalMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
