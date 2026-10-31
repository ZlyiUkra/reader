import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParserClientError } from '../src/parser-client/client.ts';
import { UnsafeOutputError } from '../src/parser-client/safe-read.ts';
import { failureOf, failureOfParserAnswer, outcomeOfFailure } from '../src/pipeline/failures.ts';

/**
 * The failure mapping of C6 (FR-027): what the app itself can throw becomes `INTERNAL_ERROR` with a cause, and what the
 * parser reported keeps its own code. Only `INTERNAL_ERROR` is retried; every other reason ends the document.
 */

test('an unreachable, busy, timed-out or confused parser is an INTERNAL_ERROR named after the failure', () => {
  for (const kind of ['connect', 'busy', 'timeout', 'protocol'] as const) {
    assert.deepEqual(failureOf(new ParserClientError(kind, 'x')), { code: 'INTERNAL_ERROR', params: { cause: `parser_${kind}` } });
  }
});

test('an output that breaks the safe-read rules is an INTERNAL_ERROR with the cause unsafe_output', () => {
  assert.deepEqual(failureOf(new UnsafeOutputError('x')), { code: 'INTERNAL_ERROR', params: { cause: 'unsafe_output' } });
});

test('anything else is still recorded, as an INTERNAL_ERROR with the cause unexpected', () => {
  assert.deepEqual(failureOf(new TypeError('boom')), { code: 'INTERNAL_ERROR', params: { cause: 'unexpected' } });
  assert.deepEqual(failureOf('a string'), { code: 'INTERNAL_ERROR', params: { cause: 'unexpected' } });
});

test('the parser\'s own reasons keep their code and parameters', () => {
  assert.deepEqual(failureOfParserAnswer({ ok: false, code: 'TOO_LARGE', params: { limit: 'page_cap', actual: 5000, max: 50 } }), {
    code: 'TOO_LARGE',
    params: { limit: 'page_cap', actual: 5000, max: 50 },
  });
  assert.deepEqual(failureOfParserAnswer({ ok: false, code: 'ENCRYPTED', params: {} }), { code: 'ENCRYPTED', params: {} });
  assert.deepEqual(failureOfParserAnswer({ ok: false, code: 'UNSUPPORTED_FORMAT', params: { mime: 'application/zip' } }), {
    code: 'UNSUPPORTED_FORMAT',
    params: { mime: 'application/zip' },
  });
});

test('the parser\'s internal error keeps its cause, or gets a generic one', () => {
  assert.deepEqual(failureOfParserAnswer({ ok: false, code: 'INTERNAL_ERROR', params: { cause: 'job_deadline' } }), { code: 'INTERNAL_ERROR', params: { cause: 'job_deadline' } });
  assert.deepEqual(failureOfParserAnswer({ ok: false, code: 'INTERNAL_ERROR', params: {} }), { code: 'INTERNAL_ERROR', params: { cause: 'parser' } });
});

test('only INTERNAL_ERROR is recorded as an internal error; every other reason ends the document', () => {
  assert.equal(outcomeOfFailure({ code: 'INTERNAL_ERROR', params: { cause: 'x' } }), 'internal_error');
  for (const code of ['TOO_LARGE', 'CORRUPT', 'ENCRYPTED', 'UNSUPPORTED_FORMAT', 'EMPTY', 'LOW_OCR_QUALITY'] as const) {
    assert.equal(outcomeOfFailure({ code, params: {} }), 'reason');
  }
});
