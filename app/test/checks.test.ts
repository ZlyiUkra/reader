import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edrpouCheckDigit, isEdrpou, isUaIban, uaIban, uaIbanCheckDigits } from '../src/shared/checksums.ts';
import { normalizeFragment, normalizeText, originalRange } from '../src/shared/normalize.ts';
import { matchEnum, parseCurrency, parseDate, parseEdrpou, parseIban, parseMoney, vatOf, vatSumHolds } from '../src/shared/values.ts';

/**
 * The shared checks and parsers (T022, FR-019, FR-021, C11, research R12 and R13): identifiers, the pinned
 * normalisation with its offset map, the date and money formats, and the exact VAT arithmetic in kopiyky. All of it is
 * pure, so the cases are tables.
 */

test('EDRPOU: real codes verify, in both weight series', () => {
  // PrivatBank 14360570 and Ukrtelecom 21560766 use the plain weights; Ukrzaliznytsia 40081216 is in 30000000-59999999.
  for (const code of ['14360570', '21560766', '40081216']) {
    assert.equal(isEdrpou(code), true, code);
  }
});

test('EDRPOU: a wrong check digit, a wrong length or a letter fails', () => {
  for (const code of ['14360571', '21560760', '40081217', '1436057', '143605700', '1436057A', '', '        ']) {
    assert.equal(isEdrpou(code), false, code);
  }
});

test('EDRPOU: the check digit computed for any prefix is the only digit that verifies', () => {
  for (const prefix of ['0000000', '1234567', '2999999', '3000000', '3456789', '5999999', '6000000', '9999999']) {
    const right = edrpouCheckDigit(prefix);
    for (let digit = 0; digit <= 9; digit += 1) {
      assert.equal(isEdrpou(`${prefix}${digit}`), digit === right, `${prefix}${digit}`);
    }
  }
});

test('EDRPOU: the second pass applies when the first sum leaves 10', () => {
  // 1, 2, 3, 4, 5, 6, 7 with weights 1 to 7 give 140, which is 8 mod 11; a prefix that leaves 10 is found by search.
  const prefix = Array.from({ length: 1_000_000 }, (_, n) => String(n).padStart(7, '0')).find((candidate) => {
    const sum = [...candidate].reduce((total, digit, index) => total + Number(digit) * (index + 1), 0);
    return sum % 11 === 10 && Number(candidate) < 3_000_000;
  });
  assert.ok(prefix !== undefined);
  const secondPass = [...prefix].reduce((total, digit, index) => total + Number(digit) * (index + 3), 0);
  assert.equal(edrpouCheckDigit(prefix), (secondPass % 11) % 10);
});

test('EDRPOU: a prefix of the wrong shape is refused', () => {
  assert.throws(() => edrpouCheckDigit('123456'), RangeError);
  assert.throws(() => edrpouCheckDigit('12345678'), RangeError);
});

test('IBAN: published Ukrainian examples verify', () => {
  for (const iban of ['UA213223130000026007233566001', 'UA903052992990004149123456789']) {
    assert.equal(isUaIban(iban), true, iban);
  }
});

test('IBAN: a changed digit, a wrong prefix, a wrong length or lower case fails', () => {
  for (const iban of [
    'UA213223130000026007233566002',
    'UA223223130000026007233566001',
    'PL213223130000026007233566001',
    'UA21322313000002600723356600',
    'UA2132231300000260072335660011',
    'ua213223130000026007233566001',
    '',
  ]) {
    assert.equal(isUaIban(iban), false, iban);
  }
});

test('IBAN: generation gives the published check digits and an IBAN that verifies', () => {
  assert.equal(uaIbanCheckDigits('322313', '0000026007233566001'), '21');
  assert.equal(uaIban('322313', '0000026007233566001'), 'UA213223130000026007233566001');
  assert.equal(isUaIban(uaIban('305299', '2990004149123456789')), true);
  assert.equal(uaIban('305299', '2990004149123456789'), 'UA903052992990004149123456789');
  assert.throws(() => uaIban('12345', '0000026007233566001'), RangeError);
});

/** The normalisation table: [name, input, expected]. */
const normalisationTable: Array<[string, string, string]> = [
  ['plain text is unchanged', 'Рахунок № 15', 'Рахунок № 15'],
  ['right single quotation mark', "п’ять", "п'ять"],
  ['left single quotation mark', "п‘ять", "п'ять"],
  ['modifier letter apostrophe', "пʼять", "п'ять"],
  ['grave accent', "п`ять", "п'ять"],
  ['non-breaking space', '1 200', '1 200'],
  ['narrow no-break space', '1 200', '1 200'],
  ['thin space', '1 200', '1 200'],
  ['a run of whitespace', 'a \t\n  b', 'a b'],
  ['soft hyphen removed', 'до­ку­мент', 'документ'],
  ['hyphen and line break join the word', 'доку-\nмент', 'документ'],
  ['hyphen, spaces, CRLF and indentation join the word', 'доку-  \r\n   мент', 'документ'],
  ['a dash after a non-letter stays', 'Сума: -\nДата', 'Сума: - Дата'],
  ['a hyphen before a digit break stays', '10-\n20', '10- 20'],
  ['a hyphen inside a word stays', 'Івано-Франківськ', 'Івано-Франківськ'],
  ['two line breaks are not a join', 'доку-\n\nмент', 'доку- мент'],
  ['decomposed letter is composed', 'й', 'й'],
  ['leading and trailing whitespace is kept as one space', '  a  ', ' a '],
];

for (const [name, input, expected] of normalisationTable) {
  test(`normalisation: ${name}`, () => {
    assert.equal(normalizeText(input).text, expected);
  });
}

test('normalisation: a fragment is also trimmed', () => {
  assert.equal(normalizeFragment('  Рахунок \n № 15  '), 'Рахунок № 15');
});

test('normalisation: offsets map back to the original', () => {
  const spaces = normalizeText('A  B');
  assert.equal(spaces.text, 'A B');
  assert.deepEqual(originalRange(spaces, 0, 3), { start: 0, end: 4 });
  assert.deepEqual(originalRange(spaces, 2, 3), { start: 3, end: 4 });

  const joined = normalizeText('доку-\nмент');
  assert.equal(joined.text, 'документ');
  assert.deepEqual(originalRange(joined, 0, 8), { start: 0, end: 10 });
  assert.deepEqual(originalRange(joined, 4, 8), { start: 6, end: 10 });

  const pair = normalizeText('😀 a');
  assert.equal(pair.text, '😀 a');
  assert.deepEqual(originalRange(pair, 0, 2), { start: 0, end: 2 });
  assert.deepEqual(originalRange(pair, 3, 4), { start: 3, end: 4 });

  const soft = normalizeText('до­м');
  assert.equal(soft.text, 'дом');
  assert.deepEqual(originalRange(soft, 0, 3), { start: 0, end: 4 });
});

test('normalisation: the same quote found through two spellings', () => {
  const page = normalizeText('Продавець: ТОВ «Дж’ям»\nрахунок № 15');
  const wanted = normalizeFragment("ТОВ «Дж'ям»");
  const at = page.text.indexOf(wanted);
  assert.ok(at >= 0);
  assert.deepEqual(originalRange(page, at, at + wanted.length), { start: 11, end: 22 });
});

test('normalisation: a range outside the text is refused', () => {
  const page = normalizeText('abc');
  assert.throws(() => originalRange(page, 2, 2), RangeError);
  assert.throws(() => originalRange(page, 0, 9), RangeError);
});

/** Dates: [fragment, ISO date or null]. */
const dateTable: Array<[string, string | null]> = [
  ['01.03.2026', '2026-03-01'],
  ['1.3.2026', '2026-03-01'],
  ['01/03/2026', '2026-03-01'],
  ['2026-03-01', '2026-03-01'],
  ['1 березня 2026', '2026-03-01'],
  ['01 березня 2026 р.', '2026-03-01'],
  ['15 ЛИСТОПАДА 2026 року', '2026-11-15'],
  ['31 грудня 2026 р.', '2026-12-31'],
  ['29.02.2028', '2028-02-29'],
  ['29.02.2026', null],
  ['31.04.2026', null],
  ['2026-13-01', null],
  ['00.03.2026', null],
  ['01.03.26', null],
  ['01.03/2026', null],
  ['березня 2026', null],
  ['1 березеня 2026', null],
  ['1 March 2026', null],
  ['', null],
];

for (const [fragment, expected] of dateTable) {
  test(`date: "${fragment}" is ${expected ?? 'refused'}`, () => {
    assert.equal(parseDate(fragment), expected);
  });
}

/** Money: [fragment, minor units and the currency written with them, or null]. */
const moneyTable: Array<[string, [number, string | null] | null]> = [
  ['1 234,56 грн', [123456, 'UAH']],
  ['1\u00A0234,56', [123456, null]],
  ['1\u2009234,56 грн.', [123456, 'UAH']],
  ['1234.56 UAH', [123456, 'UAH']],
  ['₴ 12,5', [1250, 'UAH']],
  ['12 грн.', [1200, 'UAH']],
  ['0,05', [5, null]],
  ['100', [10000, null]],
  ['1 000 000,00 грн', [100000000, 'UAH']],
  ['12 EUR', [1200, 'EUR']],
  ['€12,50', [1250, 'EUR']],
  ['1 200 євро', [120000, 'EUR']],
  ['$12', [1200, 'USD']],
  ['US$ 1 234.5', [123450, 'USD']],
  ['99,99 USD', [9999, 'USD']],
  ['15 дол.', [1500, 'USD']],
  ['1,200', null],
  ['12,345.67', null],
  ['-5,00', null],
  ['12 GBP', null],
  ['£12', null],
  ['12 руб.', null],
  ['1 23', null],
  ['abc', null],
  ['', null],
  ['грн', null],
  ['12 345 678 901 234', null],
];

for (const [fragment, expected] of moneyTable) {
  test(`money: "${fragment}" is ${expected === null ? 'refused' : `${expected[0]} ${expected[1] ?? 'with no currency'}`}`, () => {
    const money = parseMoney(fragment);
    assert.deepEqual(money === null ? null : [money.minor, money.currency], expected);
  });
}

/** The currency field: [fragment, the allowed values, the value or null]. */
const currencyTable: Array<[string, string[], string | null]> = [
  ['UAH', ['UAH', 'EUR', 'USD'], 'UAH'],
  ['грн', ['UAH', 'EUR', 'USD'], 'UAH'],
  ['грн.', ['UAH', 'EUR', 'USD'], 'UAH'],
  ['₴', ['UAH', 'EUR', 'USD'], 'UAH'],
  ['  Гривень \u00A0', ['UAH', 'EUR', 'USD'], 'UAH'],
  ['EUR', ['UAH', 'EUR', 'USD'], 'EUR'],
  ['€', ['UAH', 'EUR', 'USD'], 'EUR'],
  ['євро', ['UAH', 'EUR', 'USD'], 'EUR'],
  ['usd', ['UAH', 'EUR', 'USD'], 'USD'],
  ['$', ['UAH', 'EUR', 'USD'], 'USD'],
  ['US$', ['UAH', 'EUR', 'USD'], 'USD'],
  ['дол.', ['UAH', 'EUR', 'USD'], 'USD'],
  ['доларів', ['UAH', 'EUR', 'USD'], 'USD'],
  ['грн', ['EUR', 'USD'], null],
  ['$', ['UAH'], null],
  ['UAH.', ['UAH', 'EUR', 'USD'], null],
  ['GBP', ['UAH', 'EUR', 'USD'], null],
  ['£', ['UAH', 'EUR', 'USD'], null],
  ['крб', ['UAH', 'EUR', 'USD'], null],
  ['', ['UAH', 'EUR', 'USD'], null],
];

for (const [fragment, allowed, expected] of currencyTable) {
  test(`currency: "${fragment}" among ${allowed.join('/')} is ${expected ?? 'refused'}`, () => {
    assert.equal(parseCurrency(fragment, allowed), expected);
  });
}

test('enumeration: exact match after normalisation, nothing fuzzy', () => {
  assert.equal(matchEnum('UAH', ['UAH']), 'UAH');
  assert.equal(matchEnum('  UAH  ', ['UAH']), 'UAH');
  assert.equal(matchEnum('uah', ['UAH']), null);
  assert.equal(matchEnum('UAH.', ['UAH']), null);
  assert.equal(matchEnum('грн', ['UAH']), null, 'only the currency field goes through the table of writings');
});

test('EDRPOU and IBAN fragments are read with or without grouping', () => {
  assert.equal(parseEdrpou('1436 0570'), '14360570');
  assert.equal(parseEdrpou('1436057'), null);
  assert.equal(parseEdrpou('1436057A'), null);
  assert.equal(parseIban('UA21 3223 1300 0002 6007 2335 6600 1'), 'UA213223130000026007233566001');
  assert.equal(parseIban('ua21 3223 1300 0002 6007 2335 6600 1'), 'UA213223130000026007233566001');
  assert.equal(parseIban('UA21 3223 1300 0002 6007 2335 6600'), null);
});

test('VAT: the amount due is exact in kopiyky and rounds half up', () => {
  assert.equal(vatOf(10000, 20), 2000);
  assert.equal(vatOf(10001, 20), 2000);
  assert.equal(vatOf(10003, 20), 2001);
  assert.equal(vatOf(250, 1), 3);
  assert.equal(vatOf(249, 1), 2);
  assert.equal(vatOf(0, 20), 0);
  assert.equal(vatOf(10 ** 12, 20), 2 * 10 ** 11);
});

test('VAT: the rule holds only when net plus VAT is gross and VAT is the amount due', () => {
  assert.equal(vatSumHolds(10000, 2000, 12000, 20), true);
  assert.equal(vatSumHolds(123456, 24691, 148147, 20), true);
  assert.equal(vatSumHolds(10000, 2000, 12001, 20), false, 'gross off by one kopiyka');
  assert.equal(vatSumHolds(10000, 2001, 12001, 20), false, 'VAT off by one kopiyka');
  assert.equal(vatSumHolds(10000, 2100, 12100, 20), false, 'the wrong-VAT invoice, off by one hryvnia');
  assert.equal(vatSumHolds(10000, 1000, 11000, 20), false, 'a self-consistent sum at the wrong rate');
});
