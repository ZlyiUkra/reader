import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import type { ExtractionRow, PageReading } from '../src/db/queries.ts';
import { reasonsOfEvidence } from '../src/pipeline/check.ts';
import { deriveValue, gatherEvidence, quotesOf, storedReply } from '../src/pipeline/evidence.ts';
import type { FieldEvidence, Quote } from '../src/pipeline/evidence.ts';
import { ModelReplyError } from '../src/pipeline/model-call.ts';
import { createReasons } from '../src/reasons/reasons.ts';
import type { ReasonCode } from '../src/reasons/reasons.ts';
import { createRegistry } from '../src/registry/registry.ts';
import type { RegistryType } from '../src/registry/registry.ts';
import { uaIban } from '../src/shared/checksums.ts';
import { formatKopiyky } from '../src/shared/values.ts';

/**
 * Evidence and checks without a model or a database (T046, T047, FR-018, FR-019, FR-021, constitution V and VI): the
 * search of a quoted fragment under the pinned normalisation, the typed values derived from it, and every rule that turns
 * evidence into a reason. All of it is pure, so the cases are tables.
 */
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);
const reasons = createReasons(config.reasons);

/** A registry type by name; a missing one is a defect of the test. */
function typeNamed(name: string): RegistryType {
  const type = registry.byName.get(name);
  if (type === undefined) {
    throw new Error(`No type ${name} in the registry`);
  }
  return type;
}
const invoice = typeNamed('invoice');

/** A page reading with a made-up id. */
function reading(pageNo: number, text: string): PageReading {
  return { pageNo, pageTextId: pageNo * 100, text };
}

/** The quotes of a reply that reports every field absent, with the given fields replaced. */
function quotes(type: RegistryType, given: Record<string, Quote>): Map<string, Quote> {
  return new Map(type.fields.map((field) => [field.name, given[field.name] ?? { verbatim: null, page: null }]));
}

const goodIban = uaIban('322313', '0000026007233566001');

/** The text of a whole synthetic invoice page, with every value the tests quote. */
const invoicePage = [
  'Рахунок № РФ-2026/0412 від 15 березня 2026 р.',
  'Постачальник: ТОВ «Тест-Постач», код ЄДРПОУ 14360570',
  `IBAN постачальника: ${goodIban}`,
  'Покупець: ТОВ «Тест-Покупець», код ЄДРПОУ 21560766',
  'Разом без ПДВ: 10 000,00 грн',
  'ПДВ 20%: 2 000,00 грн',
  'Разом з ПДВ: 12 000,00 грн',
  'Оплатити до 25.03.2026.',
].join('\n');

/** The quotes a good model gives for that page. */
const goodQuotes: Record<string, Quote> = {
  number: { verbatim: 'РФ-2026/0412', page: 1 },
  date: { verbatim: '15 березня 2026 р.', page: 1 },
  sellerName: { verbatim: 'ТОВ «Тест-Постач»', page: 1 },
  sellerEdrpou: { verbatim: '14360570', page: 1 },
  sellerIban: { verbatim: goodIban, page: 1 },
  buyerName: { verbatim: 'ТОВ «Тест-Покупець»', page: 1 },
  buyerEdrpou: { verbatim: '21560766', page: 1 },
  currency: { verbatim: 'грн', page: 1 },
  totalNet: { verbatim: '10 000,00 грн', page: 1 },
  vat: { verbatim: '2 000,00 грн', page: 1 },
  totalGross: { verbatim: '12 000,00 грн', page: 1 },
  dueDate: { verbatim: '25.03.2026', page: 1 },
};

/** The evidence of the good invoice with some quotes replaced, over the given pages. */
function evidenceOf(overrides: Record<string, Quote> = {}, pages: PageReading[] = [reading(1, invoicePage)]): FieldEvidence[] {
  return gatherEvidence(invoice, quotes(invoice, { ...goodQuotes, ...overrides }), pages);
}

/** The code and parameters of each reason, which is what the tables compare. */
function found(evidence: FieldEvidence[]): Array<[ReasonCode, Record<string, string | number>]> {
  return reasonsOfEvidence(invoice, evidence).map((reason) => [reason.code, reason.params]);
}

test('a good reply gives evidence for every field and no reason', () => {
  const evidence = evidenceOf();
  assert.equal(evidence.length, invoice.fields.length);
  assert.deepEqual(evidence.map((entry) => entry.state), invoice.fields.map((field) => (field.name in goodQuotes ? 'ok' : 'absent')));
  assert.deepEqual(found(evidence), []);
});

test('the values come from the located fragments, never from the model', () => {
  const byName = new Map(evidenceOf().map((entry) => [entry.name, entry.value]));
  assert.deepEqual(byName.get('date'), { stored: '2026-03-15', canonical: '2026-03-15' });
  assert.deepEqual(byName.get('totalNet'), { stored: { amount: 1_000_000, currency: 'UAH' }, canonical: 1_000_000 });
  assert.deepEqual(byName.get('currency'), { stored: 'UAH', canonical: 'UAH' });
  assert.deepEqual(byName.get('sellerEdrpou'), { stored: '14360570', canonical: '14360570' });
  assert.deepEqual(byName.get('number'), { stored: 'РФ-2026/0412', canonical: 'РФ-2026/0412' });
});

test('the offsets point into the stored text and the page is the one where the fragment is', () => {
  const second = 'Друга сторінка.\nРазом без ПДВ: 10 000,00 грн';
  const evidence = evidenceOf({ totalNet: { verbatim: '10 000,00 грн', page: 1 } }, [reading(1, 'Перша сторінка без сум.'), reading(2, second)]);
  const net = evidence.find((entry) => entry.name === 'totalNet');
  assert.equal(net?.state, 'ok');
  assert.equal(net?.located?.pageNo, 2, 'the model said page 1; the pipeline found it on page 2');
  assert.equal(net?.located?.pageTextId, 200);
  assert.equal(second.slice(net?.located?.start, net?.located?.end), '10 000,00 грн');
});

test('a fragment that occurs on two pages is taken from the page the model named', () => {
  const pages = [reading(1, 'Сума 100,00 грн'), reading(2, 'Сума 100,00 грн')];
  const first = evidenceOf({ totalNet: { verbatim: '100,00 грн', page: 1 } }, pages).find((entry) => entry.name === 'totalNet');
  const second = evidenceOf({ totalNet: { verbatim: '100,00 грн', page: 2 } }, pages).find((entry) => entry.name === 'totalNet');
  assert.equal(first?.located?.pageNo, 1);
  assert.equal(second?.located?.pageNo, 2);
});

test('the pinned normalisation lets a true quote through: apostrophe, non-breaking space, a hyphenated line break', () => {
  const page = "Постачальник: Тов О’Коннор і Ко, договір № Д-20\n26/12";
  const evidence = evidenceOf(
    { sellerName: { verbatim: "Тов О'Коннор і Ко", page: 1 }, contractRef: { verbatim: 'Д-2026/12', page: 1 } },
    [reading(1, page)],
  );
  assert.equal(evidence.find((entry) => entry.name === 'sellerName')?.state, 'ok');
  // The hyphen at "Д-20" is inside a word and not at the end of a line, so it is not a line break: the quote must not match across the newline.
  assert.equal(evidence.find((entry) => entry.name === 'contractRef')?.state, 'not-located');
  const broken = evidenceOf({ contractRef: { verbatim: 'договір', page: 1 } }, [reading(1, 'до-\nговір № 5')]);
  assert.equal(broken.find((entry) => entry.name === 'contractRef')?.state, 'ok');
});

test('a different word is not a match: a near quote is not evidence', () => {
  const evidence = evidenceOf({ sellerName: { verbatim: 'ТОВ «Тест-Постачальник»', page: 1 } });
  assert.equal(evidence.find((entry) => entry.name === 'sellerName')?.state, 'not-located');
});

test('a blank quote counts as absent', () => {
  assert.equal(evidenceOf({ dueDate: { verbatim: '   ', page: 1 } }).find((entry) => entry.name === 'dueDate')?.state, 'absent');
});

test('typed values by kind: the writings the contract names', () => {
  const field = (name: string) => {
    const entry = invoice.fields.find((candidate) => candidate.name === name);
    if (entry === undefined) {
      throw new Error(name);
    }
    return entry;
  };
  const cases: Array<[string, string, unknown]> = [
    ['date', '01.03.2026', '2026-03-01'],
    ['date', '1 березня 2026 року', '2026-03-01'],
    ['date', '30.02.2026', null],
    ['totalNet', '1 234,5 грн', { amount: 123_450, currency: 'UAH' }],
    ['totalNet', '100', { amount: 10_000, currency: null }],
    ['totalNet', 'Разом: 100,00', null],
    ['currency', '₴', 'UAH'],
    ['currency', 'євро', 'EUR'],
    ['currency', 'грн.', 'UAH'],
    ['currency', 'peso', null],
    ['sellerEdrpou', '1436 0570', '14360570'],
    ['sellerEdrpou', '1436057', null],
    ['sellerIban', goodIban.replace(/(.{4})/g, '$1 ').trim(), goodIban],
    ['sellerIban', 'UA12', null],
  ];
  for (const [name, fragment, expected] of cases) {
    const value = deriveValue(invoice, field(name), fragment);
    assert.deepEqual(value === null ? null : value.stored, expected, `${name}: ${fragment}`);
  }
});

test('a reply and its stored form: the page the model named is read back from the raw reply', () => {
  const content = JSON.stringify({ number: { verbatim: 'x', page: 3 } });
  const base = { id: 7, document_id: 1, kind: 'extract' as const, attempt: 3, adapter: 'ollama', schema_id: null, done_reason: 'stop', cold: false };
  const chat: ExtractionRow = { ...base, raw_request: { endpoint: '/api/chat' }, raw_response: { message: { content } } };
  const generate: ExtractionRow = { ...base, raw_request: { endpoint: '/api/generate' }, raw_response: { response: content } };
  assert.deepEqual(storedReply(chat), { number: { verbatim: 'x', page: 3 } });
  assert.deepEqual(storedReply(generate), { number: { verbatim: 'x', page: 3 } });
  assert.throws(() => storedReply({ ...chat, raw_request: { endpoint: '/other' } }), ModelReplyError);
  assert.throws(() => storedReply({ ...chat, raw_response: { message: { content: 'not json' } } }), ModelReplyError);
  assert.throws(() => quotesOf(invoice, { number: { verbatim: 5, page: 1 } }), ModelReplyError);
  assert.throws(() => quotesOf(invoice, 'text'), ModelReplyError);
});

test('kopiyky are written as exact decimals', () => {
  assert.deepEqual([0, 5, 100, 1_200_050].map(formatKopiyky), ['0.00', '0.05', '1.00', '12000.50']);
});

test('the reasons of the evidence, one case each', () => {
  const cases: Array<{ name: string; overrides: Record<string, Quote>; expected: Array<[ReasonCode, Record<string, string | number>]> }> = [
    { name: 'a required field the model reported absent', overrides: { sellerIban: { verbatim: null, page: null } }, expected: [['MISSING_REQUIRED_FIELD', { field: 'sellerIban' }]] },
    { name: 'an optional field that is absent breaks nothing', overrides: { dueDate: { verbatim: null, page: null } }, expected: [] },
    {
      name: 'a quote that is not in the text',
      overrides: { sellerName: { verbatim: 'ТОВ «Вигадане»', page: 1 } },
      expected: [['VALIDATION_FAILED', { field: 'sellerName', fragment: 'ТОВ «Вигадане»', page: 1 }]],
    },
    {
      name: 'a quote that is not in the text and no page named',
      overrides: { sellerName: { verbatim: 'ТОВ «Вигадане»', page: null } },
      expected: [['VALIDATION_FAILED', { field: 'sellerName', fragment: 'ТОВ «Вигадане»', page: 0 }]],
    },
    {
      name: 'a located fragment that is not a date',
      overrides: { date: { verbatim: 'Рахунок', page: 1 } },
      expected: [['VALIDATION_FAILED', { check: 'value', field: 'date', fragment: 'Рахунок' }]],
    },
    {
      name: 'VAT off by one hryvnia',
      overrides: { totalNet: { verbatim: '10 001,00', page: 1 } },
      expected: [['VALIDATION_FAILED', { check: 'vat_sum', net: '10001.00', vat: '2000.00', gross: '12000.00', rate: 20 }]],
    },
    {
      name: 'date order reversed',
      overrides: { date: { verbatim: '25.03.2026', page: 1 }, dueDate: { verbatim: '15 березня 2026 р.', page: 1 } },
      expected: [['VALIDATION_FAILED', { check: 'date_order', earlier: '2026-03-25', later: '2026-03-15' }]],
    },
    {
      name: 'an EDRPOU whose check digit does not verify',
      overrides: { sellerEdrpou: { verbatim: '14360571', page: 1 } },
      expected: [['VALIDATION_FAILED', { check: 'edrpou', field: 'sellerEdrpou' }]],
    },
  ];
  for (const testCase of cases) {
    // The page text is extended so that every quote of a case can be located.
    const page = `${invoicePage}\n25.03.2026 14360571 ТОВ «Тест-Постач» 10 001,00 Рахунок`;
    const evidence = evidenceOf(testCase.overrides, [reading(1, page)]);
    assert.deepEqual(found(evidence), testCase.expected, testCase.name);
  }
});

test('the VAT rule is exact: a kopiyka off fails, and so does a total that does not add up', () => {
  const page = `${invoicePage}\n10 000,01 грн 2 000,00 грн 12 000,01 грн 12 500,00 грн`;
  const nearly = found(evidenceOf({ totalNet: { verbatim: '10 000,01 грн', page: 1 } }, [reading(1, page)]));
  assert.deepEqual(nearly, [['VALIDATION_FAILED', { check: 'vat_sum', net: '10000.01', vat: '2000.00', gross: '12000.00', rate: 20 }]]);
  const sums = found(evidenceOf({ totalGross: { verbatim: '12 500,00 грн', page: 1 } }, [reading(1, page)]));
  assert.deepEqual(sums, [['VALIDATION_FAILED', { check: 'vat_sum', net: '10000.00', vat: '2000.00', gross: '12500.00', rate: 20 }]]);
});

test('an IBAN with a wrong check digit fails the iban rule', () => {
  const bad = `UA00${goodIban.slice(4)}`;
  const evidence = evidenceOf({ sellerIban: { verbatim: bad, page: 1 } }, [reading(1, `${invoicePage}\n${bad}`)]);
  assert.deepEqual(found(evidence), [['VALIDATION_FAILED', { check: 'iban_ua', field: 'sellerIban' }]]);
});

test('a rule whose fields are missing is skipped, because those fields carry their own reason', () => {
  const evidence = evidenceOf({ vat: { verbatim: null, page: null } });
  assert.deepEqual(found(evidence), [['MISSING_REQUIRED_FIELD', { field: 'vat' }]]);
});

test('every reason the step can write renders in both languages with no placeholder left', () => {
  const page = `${invoicePage}\n25.03.2026 14360571 10 001,00`;
  const samples = [
    evidenceOf({ sellerIban: { verbatim: null, page: null } }, [reading(1, page)]),
    evidenceOf({ sellerName: { verbatim: 'немає', page: 2 } }, [reading(1, page)]),
    evidenceOf({ date: { verbatim: 'Рахунок', page: 1 } }, [reading(1, page)]),
    evidenceOf({ totalNet: { verbatim: '10 001,00', page: 1 } }, [reading(1, page)]),
    evidenceOf({ date: { verbatim: '25.03.2026', page: 1 }, dueDate: { verbatim: '15 березня 2026 р.', page: 1 } }, [reading(1, page)]),
    evidenceOf({ sellerEdrpou: { verbatim: '14360571', page: 1 } }, [reading(1, page)]),
    evidenceOf({ sellerIban: { verbatim: `UA00${goodIban.slice(4)}`, page: 1 } }, [reading(1, `${page}\nUA00${goodIban.slice(4)}`)]),
  ];
  for (const evidence of samples) {
    const produced = reasonsOfEvidence(invoice, evidence);
    assert.ok(produced.length > 0);
    for (const reason of produced) {
      for (const lang of ['uk', 'en'] as const) {
        const text = reasons.render(reason.code, reason.params, lang);
        assert.doesNotMatch(text, /[{}]/, `${reason.code} ${lang}: ${text}`);
      }
    }
  }
});
