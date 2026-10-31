import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import type { ReasonsFile } from '../src/config/types.ts';
import { createReasons, reasonCodes, ReasonsError } from '../src/reasons/reasons.ts';
import type { ReasonCode } from '../src/reasons/reasons.ts';
import { format, placeholders } from '../src/shared/format.ts';

/**
 * The reasons file against the closed list of codes, and the rendering of messages (FR-024, FR-025, FR-058, C1). The file
 * is the real config/reasons.json, read through the same loader the application uses at start.
 */
const { reasons: file } = await loadConfig(resolveConfigDirs(process.env));
const reasons = createReasons(file);

/** A deep copy of the real file, for the cases that damage it. */
function copyOfFile(): ReasonsFile {
  return structuredClone(file);
}

test('the real file declares exactly the 15 codes, 11 of them emitted', () => {
  assert.deepEqual(file.reasons.map((entry) => entry.code), Object.keys(reasonCodes));
  assert.equal(file.reasons.filter((entry) => entry.emitted).length, 11);
});

test('every code renders in both languages with its own parameters and leaves no placeholder behind', () => {
  for (const entry of file.reasons) {
    const params = Object.fromEntries(entry.params.map((param) => [param.name, param.kind === 'string' || param.kind === 'date' ? 'x' : 7]));
    for (const lang of ['uk', 'en'] as const) {
      const message = reasons.render(entry.code as ReasonCode, params, lang);
      assert.equal(placeholders(message).length, 0, `${entry.code} ${lang}: ${message}`);
      assert.ok(message.length > 0);
    }
  }
});

test('the fragment template of VALIDATION_FAILED is the one of C1, verbatim', () => {
  const message = reasons.render('VALIDATION_FAILED', { field: 'number', fragment: 'INV-1', page: 2 }, 'en');
  assert.equal(message, 'Field "number": the quoted fragment "INV-1" is not in the text of page 2.');
});

test('VALIDATION_FAILED takes the first variant whose when-entries all equal the params', () => {
  const vat = reasons.render('VALIDATION_FAILED', { check: 'vat_sum', net: '100.00', vat: '20.00', gross: '121.00', rate: 20 }, 'en');
  assert.match(vat, /^VAT check failed: net 100\.00 plus VAT 20\.00 must equal the total 121\.00/);
  const iban = reasons.render('VALIDATION_FAILED', { check: 'iban_ua', field: 'sellerIban' }, 'uk');
  assert.match(iban, /sellerIban/);
  assert.match(iban, /IBAN/);
  const dates = reasons.render('VALIDATION_FAILED', { check: 'date_order', earlier: 'date', later: 'dueDate' }, 'en');
  assert.match(dates, /^Date check failed/);
  const edrpou = reasons.render('VALIDATION_FAILED', { check: 'edrpou', field: 'buyerEdrpou' }, 'en');
  assert.match(edrpou, /EDRPOU/);
});

test('without a matching variant the base template applies', () => {
  const message = reasons.render('VALIDATION_FAILED', { check: 'something_else', field: 'a', fragment: 'b', page: 1 }, 'en');
  assert.match(message, /^Field "a": the quoted fragment "b"/);
});

test('a parameter value is never expanded a second time', () => {
  const message = reasons.render('VALIDATION_FAILED', { field: 'number', fragment: '{field}', page: 1 }, 'en');
  assert.equal(message, 'Field "number": the quoted fragment "{field}" is not in the text of page 1.');
});

test('a missing parameter stays visible as its placeholder', () => {
  assert.equal(reasons.render('MISSING_REQUIRED_FIELD', {}, 'en'), 'Required field "{field}" not found.');
  assert.equal(format('{constructor} and {toString}', {}), '{constructor} and {toString}');
});

test('the file is refused when it disagrees with the closed list', () => {
  const missing = copyOfFile();
  missing.reasons = missing.reasons.filter((entry) => entry.code !== 'EMPTY');
  assert.throws(() => createReasons(missing), (error: unknown) => error instanceof ReasonsError && /does not declare: EMPTY/.test(error.message));

  const extra = copyOfFile();
  extra.reasons.push({ ...structuredClone(file.reasons[0]!), code: 'MADE_UP' });
  assert.throws(() => createReasons(extra), /MADE_UP, which is not one of the 15 codes/);

  const wrongOutcome = copyOfFile();
  wrongOutcome.reasons.find((entry) => entry.code === 'CORRUPT')!.outcome = 'NEEDS_REVIEW';
  assert.throws(() => createReasons(wrongOutcome), /CORRUPT the outcome NEEDS_REVIEW; the status rules expect REJECTED/);
});

test('a template naming an undeclared parameter, or only in one language, is refused', () => {
  const undeclared = copyOfFile();
  undeclared.reasons.find((entry) => entry.code === 'CORRUPT')!.templates.en = 'Damaged (tool {toll}).';
  assert.throws(() => createReasons(undeclared), /CORRUPT: the placeholder \{(tool|toll)\} is not in both/);

  const oneLanguage = copyOfFile();
  oneLanguage.reasons.find((entry) => entry.code === 'UNSUPPORTED_FORMAT')!.templates.uk = 'Формат не підтримується.';
  assert.throws(() => createReasons(oneLanguage), /UNSUPPORTED_FORMAT: the placeholder \{mime\} is not in both/);

  const undeclaredBoth = copyOfFile();
  const corrupt = undeclaredBoth.reasons.find((entry) => entry.code === 'CORRUPT')!;
  corrupt.templates.uk = 'Пошкоджено ({toll}).';
  corrupt.templates.en = 'Damaged ({toll}).';
  assert.throws(() => createReasons(undeclaredBoth), /CORRUPT: the placeholder \{toll\} is not a declared parameter/);
});
