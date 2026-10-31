import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, beforeEach, test } from 'node:test';
import { claimNext, finishStep } from '../src/db/claim.ts';
import type { Claimed, Step } from '../src/db/claim.ts';
import { stepRunsOf } from '../src/db/queries.ts';
import { withTransaction } from '../src/db/tx.ts';
import { startWorker } from '../src/worker.ts';
import type { WorkerLogger } from '../src/worker.ts';
import { addDocument, endOpenDocuments, stateOf, testDatabase } from './support/db.ts';

/**
 * The boot requeue (T068, FR-031, named simplification), against the real PostgreSQL: a document left in flight by an
 * instance that died is released when an instance with the same id starts, and the worker then finishes it once, with no
 * second row for the document. The lease is set to ten minutes so that only the boot requeue can have freed it.
 */
const database = await testDatabase();
const pool = database.pool;
after(() => database.close());
beforeEach(() => endOpenDocuments(pool));

/** A logger that keeps the lines, so a test can look at what the worker said. */
function recordingLogger(): WorkerLogger & { lines: string[] } {
  const lines: string[] = [];
  const write = (_fields: object, message: string) => {
    lines.push(message);
  };
  return { info: write, warn: write, error: write, lines };
}

/** A parse handler that ends the attempt successfully, as a finished step would. */
async function finishOk(claimed: Claimed): Promise<void> {
  await withTransaction(pool, (client) =>
    finishStep(client, { documentId: claimed.document.id, stepRunId: claimed.stepRunId, step: claimed.step, outcome: 'ok', details: {}, statusWhenOpen: 'CLASSIFY' }),
  );
}

/** Waits until `done` is true, or fails after `ms`. */
async function until(done: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < deadline, 'the condition did not come true in time');
    await sleep(25);
  }
}

test('a document left in flight by a dead instance is requeued at start and completes once', async () => {
  const doc = await addDocument(pool);
  const dead = await claimNext(pool, { steps: ['parse'], leaseSeconds: () => 600, instanceId: 'instance-1' });
  assert.equal(dead?.document.id, doc.id, 'the first run claimed it and then died without finishing');

  const logger = recordingLogger();
  const worker = startWorker({
    pool,
    handlers: { parse: finishOk },
    modelReady: async () => false,
    leaseSeconds: () => 600,
    instanceId: 'instance-1',
    pollIntervalMs: 20,
    logger,
  });
  await until(async () => (await stateOf(pool, doc.id)).status === 'CLASSIFY');
  await worker.stop();

  const count = await pool.query<{ count: number }>('SELECT count(*) AS count FROM documents WHERE sha256 = $1', [doc.sha256]);
  assert.equal(count.rows[0]?.count, 1, 'no second row for the document');
  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts, by: state.locked_by }, { status: 'CLASSIFY', attempts: 2, by: null });
  const runs = await stepRunsOf(pool, doc.id);
  assert.deepEqual(runs.map((run) => [run.attempt, run.outcome]), [[1, null], [2, 'ok']], 'the dead attempt is left open, the new one is complete');
  assert.ok(logger.lines.includes('Documents left in flight by the previous run were released.'));
});

test('a document locked by another instance is left alone by the boot requeue', async () => {
  const doc = await addDocument(pool);
  await claimNext(pool, { steps: ['parse'], leaseSeconds: () => 600, instanceId: 'instance-other' });
  const worker = startWorker({
    pool,
    handlers: { parse: finishOk },
    modelReady: async () => false,
    leaseSeconds: () => 600,
    instanceId: 'instance-2',
    pollIntervalMs: 20,
    logger: recordingLogger(),
  });
  await sleep(300);
  await worker.stop();
  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts, by: state.locked_by }, { status: 'PARSE', attempts: 1, by: 'instance-other' });
});

test('a step without a handler is never claimed, and the model steps wait while the model is not ready', async () => {
  const waiting = await addDocument(pool);
  await pool.query("UPDATE documents SET status = 'CLASSIFY' WHERE id = $1", [waiting.id]);
  const claimedSteps: Step[] = [];
  const worker = startWorker({
    pool,
    handlers: {
      classify: async (claimed) => {
        claimedSteps.push(claimed.step);
        await finishOk(claimed);
      },
    },
    modelReady: async () => false,
    leaseSeconds: () => 600,
    instanceId: 'instance-3',
    pollIntervalMs: 20,
    logger: recordingLogger(),
  });
  await sleep(300);
  assert.deepEqual(claimedSteps, [], 'no model step is claimed while the model is missing');
  assert.deepEqual({ status: (await stateOf(pool, waiting.id)).status, attempts: (await stateOf(pool, waiting.id)).attempts }, { status: 'CLASSIFY', attempts: 0 });
  await worker.stop();
});
