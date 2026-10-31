import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { LeaseLostError, claimNext, finishStep, recoverExpiredLeases, requeueOwn } from '../src/db/claim.ts';
import type { Step } from '../src/db/claim.ts';
import { reasonsOf, stepRunsOf } from '../src/db/queries.ts';
import { withTransaction } from '../src/db/tx.ts';
import { recordFailure } from '../src/pipeline/failures.ts';
import { addDocument, endOpenDocuments, stateOf, testDatabase } from './support/db.ts';

/**
 * The queue against the real PostgreSQL (research R10, FR-030, FR-031, C6): claiming with a lease, finishing in one
 * transaction, the three-attempts rule, the expiry of a lease counting as an attempt, and the steps that must wait.
 */
const database = await testDatabase();
const pool = database.pool;
after(() => database.close());
beforeEach(() => endOpenDocuments(pool));

/** Claim options for the parse step with a lease of `seconds`. */
function parseClaim(instanceId: string, seconds = 600) {
  return { steps: ['parse'] as Step[], leaseSeconds: () => seconds, instanceId };
}

test('a claim takes the oldest waiting document, sets its lease and opens the attempt', async () => {
  const first = await addDocument(pool);
  const second = await addDocument(pool);
  const claimed = await claimNext(pool, parseClaim('a'));
  assert.equal(claimed?.document.id, first.id);
  assert.equal(claimed?.step, 'parse');
  assert.equal(claimed?.attempt, 1);
  const state = await stateOf(pool, first.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts, by: state.locked_by }, { status: 'PARSE', attempts: 1, by: 'a' });
  assert.ok(state.locked_until !== null && state.locked_until.getTime() > Date.now() + 500_000, 'the lease is about ten minutes');
  const runs = await stepRunsOf(pool, first.id);
  assert.equal(runs.length, 1);
  assert.deepEqual({ step: runs[0]?.step, attempt: runs[0]?.attempt, finished: runs[0]?.finished_at }, { step: 'parse', attempt: 1, finished: null });
  // The leased document is not handed out again; the next claim takes the next one, then nothing.
  assert.equal((await claimNext(pool, parseClaim('a')))?.document.id, second.id);
  assert.equal(await claimNext(pool, parseClaim('a')), null);
});

test('finishing a step completes the attempt and moves the document on in one transaction', async () => {
  const doc = await addDocument(pool);
  const claimed = await claimNext(pool, parseClaim('a'));
  assert.ok(claimed);
  const status = await withTransaction(pool, (client) =>
    finishStep(client, { documentId: doc.id, stepRunId: claimed.stepRunId, step: 'parse', outcome: 'ok', details: { pages: 1 }, statusWhenOpen: 'CLASSIFY' }),
  );
  assert.equal(status, 'CLASSIFY');
  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, by: state.locked_by, until: state.locked_until }, { status: 'CLASSIFY', by: null, until: null });
  const run = (await stepRunsOf(pool, doc.id))[0];
  assert.equal(run?.outcome, 'ok');
  assert.ok(run?.finished_at !== null);
  assert.deepEqual(run?.details, { pages: 1 });
});

test('a document that waits for the model is not claimed until its step is wanted', async () => {
  const doc = await addDocument(pool);
  await pool.query("UPDATE documents SET status = 'CLASSIFY' WHERE id = $1", [doc.id]);
  assert.equal(await claimNext(pool, parseClaim('a')), null);
  const asked: Step[] = [];
  const claimed = await claimNext(pool, {
    steps: ['parse', 'classify'],
    leaseSeconds: (step) => {
      asked.push(step);
      return 60;
    },
    instanceId: 'a',
  });
  assert.equal(claimed?.document.id, doc.id);
  assert.equal(claimed?.step, 'classify');
  assert.deepEqual(asked, ['classify']);
});

test('a reason that ends the document does so after one attempt, without a retry', async () => {
  const doc = await addDocument(pool);
  const claimed = await claimNext(pool, parseClaim('a'));
  assert.ok(claimed);
  const status = await recordFailure(pool, claimed, { code: 'TOO_LARGE', params: { limit: 'page_cap', actual: 5000, max: 50 } }, {});
  assert.equal(status, 'REJECTED');
  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts }, { status: 'REJECTED', attempts: 1 });
  assert.equal(await claimNext(pool, parseClaim('a')), null);
  const run = (await stepRunsOf(pool, doc.id))[0];
  assert.equal(run?.outcome, 'reason');
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => [reason.code, reason.attempt]), [['TOO_LARGE', 1]]);
});

test('three INTERNAL_ERROR end the document FAILED, and the first two put it back at its step', async () => {
  const doc = await addDocument(pool);
  const statuses: Array<string | null> = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimNext(pool, parseClaim('a'));
    assert.equal(claimed?.document.id, doc.id, `attempt ${attempt} claims the same document`);
    assert.ok(claimed);
    statuses.push(await recordFailure(pool, claimed, { code: 'INTERNAL_ERROR', params: { cause: 'parser_timeout' } }, {}));
  }
  assert.deepEqual(statuses, ['PARSE', 'PARSE', 'FAILED']);
  assert.equal(await claimNext(pool, parseClaim('a')), null);
  const state = await stateOf(pool, doc.id);
  assert.deepEqual({ status: state.status, attempts: state.attempts }, { status: 'FAILED', attempts: 3 });
  assert.deepEqual((await stepRunsOf(pool, doc.id)).map((run) => run.outcome), ['internal_error', 'internal_error', 'internal_error']);
  assert.deepEqual((await reasonsOf(pool, doc.id)).map((reason) => reason.attempt), [1, 2, 3]);
});

test('an expired lease counts as the attempt that was running, and three of them end FAILED', async () => {
  const doc = await addDocument(pool);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimNext(pool, parseClaim('a', 0));
    assert.equal(claimed?.document.id, doc.id, `attempt ${attempt} claims the same document`);
    assert.equal(await recoverExpiredLeases(pool), 1);
    const state = await stateOf(pool, doc.id);
    assert.equal(state.status, attempt < 3 ? 'PARSE' : 'FAILED');
  }
  const runs = await stepRunsOf(pool, doc.id);
  assert.deepEqual(runs.map((run) => run.outcome), ['lease_expired', 'lease_expired', 'lease_expired']);
  const reasons = await reasonsOf(pool, doc.id);
  assert.deepEqual(reasons.map((reason) => [reason.code, reason.params, reason.attempt]), [
    ['INTERNAL_ERROR', { cause: 'lease_expired' }, 1],
    ['INTERNAL_ERROR', { cause: 'lease_expired' }, 2],
    ['INTERNAL_ERROR', { cause: 'lease_expired' }, 3],
  ]);
});

test('a step that finishes after its lease was recovered stores nothing', async () => {
  const doc = await addDocument(pool);
  const claimed = await claimNext(pool, parseClaim('a', 0));
  assert.ok(claimed);
  assert.equal(await recoverExpiredLeases(pool), 1);
  await assert.rejects(
    withTransaction(pool, (client) =>
      finishStep(client, { documentId: doc.id, stepRunId: claimed.stepRunId, step: 'parse', outcome: 'ok', details: {}, statusWhenOpen: 'CLASSIFY' }),
    ),
    LeaseLostError,
  );
  assert.equal(await recordFailure(pool, claimed, { code: 'INTERNAL_ERROR', params: { cause: 'x' } }, {}), null);
  assert.equal((await stateOf(pool, doc.id)).status, 'PARSE', 'the recovery decided, not the late step');
  assert.equal((await reasonsOf(pool, doc.id)).length, 1, 'only the lease_expired reason exists');
});

test('the boot requeue releases the rows of this instance and no others', async () => {
  const mine = await addDocument(pool);
  const theirs = await addDocument(pool);
  assert.equal((await claimNext(pool, parseClaim('mine')))?.document.id, mine.id);
  assert.equal((await claimNext(pool, parseClaim('theirs')))?.document.id, theirs.id);
  assert.equal(await requeueOwn(pool, 'mine'), 1);
  const releasedState = await stateOf(pool, mine.id);
  assert.deepEqual({ status: releasedState.status, by: releasedState.locked_by, until: releasedState.locked_until }, { status: 'PARSE', by: null, until: null });
  assert.equal((await stateOf(pool, theirs.id)).locked_by, 'theirs');
});
