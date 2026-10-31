import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reasonCodes } from '../src/reasons/reasons.ts';
import type { ReasonCode } from '../src/reasons/reasons.ts';
import { currentStep, status } from '../src/reasons/status.ts';
import type { StatusResult, StoredReason } from '../src/reasons/status.ts';

/**
 * Table test of the status function (FR-026, C1, acceptance check 9): every one of the 15 codes alone, then the
 * combinations that decide precedence, then both branches of the INTERNAL_ERROR attempt rule. It needs neither the
 * database nor the model.
 */

/** A reason emitted by `attempt`, written short for the tables. */
function reason(code: ReasonCode, attempt = 1): StoredReason {
  return { code, attempt };
}

/** One code, alone, on the first attempt, with the checks not done: the status it leads to. */
const singleCode: Record<Exclude<ReasonCode, 'DUPLICATE'>, StatusResult> = {
  ENCRYPTED: 'REJECTED',
  CORRUPT: 'REJECTED',
  MALWARE: 'QUARANTINED',
  TOO_LARGE: 'REJECTED',
  UNSUPPORTED_FORMAT: 'REJECTED',
  LOW_OCR_QUALITY: 'NEEDS_REVIEW',
  UNKNOWN_DOC_TYPE: 'NEEDS_REVIEW',
  MISSING_REQUIRED_FIELD: 'NEEDS_REVIEW',
  VALIDATION_FAILED: 'NEEDS_REVIEW',
  LOW_CONFIDENCE: 'NEEDS_REVIEW',
  EMPTY: 'NEEDS_REVIEW',
  INTERNAL_ERROR: currentStep,
  EXTRACTORS_DISAGREE: 'NEEDS_REVIEW',
  TEXT_LAYER_MISMATCH: 'NEEDS_REVIEW',
};

test('the table covers all 15 codes, DUPLICATE being the one that must throw', () => {
  const covered = [...Object.keys(singleCode), 'DUPLICATE'].sort();
  assert.deepEqual(covered, Object.keys(reasonCodes).sort());
  assert.equal(covered.length, 15);
});

for (const [code, expected] of Object.entries(singleCode)) {
  test(`${code} alone gives ${expected}`, () => {
    assert.equal(status([reason(code as ReasonCode)], 1, false), expected);
  });
}

test('DUPLICATE never reaches the function: it throws instead of giving a status', () => {
  assert.throws(() => status([reason('DUPLICATE')], 1, false), /never reaches the status function/);
  assert.throws(() => status([reason('DUPLICATE'), reason('ENCRYPTED')], 1, true), /never reaches the status function/);
});

test('a code outside the list throws instead of being ignored', () => {
  const stranger: string = 'NOT_A_CODE';
  assert.throws(() => status([{ code: stranger as ReasonCode, attempt: 1 }], 1, true), /Unknown reason code/);
});

/** INTERNAL_ERROR and the attempt counter: both branches, and the reason of an older attempt. */
const attemptRule: Array<{ name: string; reasons: StoredReason[]; attempts: number; checksDone: boolean; expected: StatusResult }> = [
  { name: 'first attempt fails: the step is requeued', reasons: [reason('INTERNAL_ERROR', 1)], attempts: 1, checksDone: false, expected: currentStep },
  { name: 'second attempt fails: the step is requeued', reasons: [reason('INTERNAL_ERROR', 1), reason('INTERNAL_ERROR', 2)], attempts: 2, checksDone: false, expected: currentStep },
  { name: 'third attempt fails: FAILED', reasons: [reason('INTERNAL_ERROR', 1), reason('INTERNAL_ERROR', 2), reason('INTERNAL_ERROR', 3)], attempts: 3, checksDone: false, expected: 'FAILED' },
  { name: 'attempts beyond the limit stay FAILED', reasons: [reason('INTERNAL_ERROR', 4)], attempts: 4, checksDone: false, expected: 'FAILED' },
  { name: 'an error of an older attempt does not count once the step has recovered', reasons: [reason('INTERNAL_ERROR', 1)], attempts: 2, checksDone: true, expected: 'ACCEPTED' },
  { name: 'an older error does not count while the new attempt is still running', reasons: [reason('INTERNAL_ERROR', 1)], attempts: 2, checksDone: false, expected: currentStep },
  { name: 'older errors do not hide a review code of the current attempt', reasons: [reason('INTERNAL_ERROR', 1), reason('VALIDATION_FAILED', 2)], attempts: 2, checksDone: true, expected: 'NEEDS_REVIEW' },
];

for (const row of attemptRule) {
  test(`attempt rule: ${row.name}`, () => {
    assert.equal(status(row.reasons, row.attempts, row.checksDone), row.expected);
  });
}

/** Precedence: the first matching rule wins (C1 lines 1 to 6). */
const precedence: Array<{ name: string; reasons: StoredReason[]; attempts: number; checksDone: boolean; expected: StatusResult }> = [
  { name: 'quarantine before rejection', reasons: [reason('ENCRYPTED'), reason('MALWARE')], attempts: 1, checksDone: false, expected: 'QUARANTINED' },
  { name: 'rejection before FAILED', reasons: [reason('INTERNAL_ERROR', 3), reason('CORRUPT', 3)], attempts: 3, checksDone: false, expected: 'REJECTED' },
  { name: 'rejection before review', reasons: [reason('EMPTY'), reason('TOO_LARGE')], attempts: 1, checksDone: false, expected: 'REJECTED' },
  { name: 'FAILED before review', reasons: [reason('MISSING_REQUIRED_FIELD', 3), reason('INTERNAL_ERROR', 3)], attempts: 3, checksDone: true, expected: 'FAILED' },
  { name: 'a pending retry before review', reasons: [reason('VALIDATION_FAILED'), reason('INTERNAL_ERROR')], attempts: 1, checksDone: true, expected: currentStep },
  { name: 'review codes together stay NEEDS_REVIEW', reasons: [reason('MISSING_REQUIRED_FIELD'), reason('VALIDATION_FAILED')], attempts: 1, checksDone: true, expected: 'NEEDS_REVIEW' },
  { name: 'no reasons and checks done is ACCEPTED', reasons: [], attempts: 1, checksDone: true, expected: 'ACCEPTED' },
  { name: 'no reasons and checks not done stays at the step', reasons: [], attempts: 1, checksDone: false, expected: currentStep },
  { name: 'a review code is NEEDS_REVIEW whether or not the checks are done', reasons: [reason('UNKNOWN_DOC_TYPE')], attempts: 1, checksDone: true, expected: 'NEEDS_REVIEW' },
];

for (const row of precedence) {
  test(`precedence: ${row.name}`, () => {
    assert.equal(status(row.reasons, row.attempts, row.checksDone), row.expected);
  });
}
