import { vatOf } from '../../app/src/shared/values.ts';
import { companies } from './companies.ts';

/** The registered document types the fixtures cover; `none` is the document of no registered type. */
export type FixtureType = 'invoice' | 'act' | 'contract' | 'none';

/**
 * How a fixture file is produced (research R8): a text PDF, a scanned PDF, the other formats of the intake list. The
 * name is also the `format` of the manifest row.
 */
export type FixtureFormat = 'pdf' | 'pdf-scan' | 'docx' | 'doc' | 'rtf' | 'xlsx' | 'png' | 'jpg' | 'svg';

/**
 * How the values are written on the page, so the set exercises the pinned normalisation (R13) and not one spelling:
 * dates with dots or with the month as a word in the genitive, thousands separated by a space or a non-breaking space,
 * the currency as the word for hryvnia or the code `UAH`.
 */
export type Writing = {
  dates: 'dotted' | 'worded';
  thousands: 'space' | 'nbsp';
  currency: 'word' | 'code';
};

/** The terminal status and the reason codes the pipeline is expected to give a fixture (spec, User Story 1). */
export type Expectation = {
  status: 'ACCEPTED' | 'NEEDS_REVIEW';
  codes: string[];
};

/**
 * One fixture. `fields` is the instance of the type schema that fills the template and, unchanged, the expected
 * extraction (FR-047, C14): dates are ISO strings and money is an integer count of kopiyky, exactly as the schemas
 * state them. A required field that is absent from `fields` is absent from the page too. For `type: 'none'` the fields
 * are the plain strings of the letter template and there is no expected instance.
 */
export type Fixture = {
  file: string;
  type: FixtureType;
  format: FixtureFormat;
  template: 'invoice' | 'act' | 'contract' | 'letter';
  writing: Writing;
  fields: Record<string, string | number>;
  expected: Expectation;
};

/** An amount of hryvnias and kopiyky as an integer count of kopiyky (C11: money is never a float). */
function uah(whole: number, kopiyky = 0): number {
  return whole * 100 + kopiyky;
}

/** The three amounts of a document whose VAT at 20% is exactly right: net, VAT and gross, in kopiyky. */
function amounts(net: number): { totalNet: number; vat: number; totalGross: number } {
  const vat = vatOf(net, 20);
  return { totalNet: net, vat, totalGross: net + vat };
}

const { cherry, bee, crow } = companies;

const accepted: Expectation = { status: 'ACCEPTED', codes: [] };
const missingField: Expectation = { status: 'NEEDS_REVIEW', codes: ['MISSING_REQUIRED_FIELD'] };

/**
 * The fixed data object of the eleven documents (FR-045): three types in three documents each, spread over nine
 * formats, with exactly one required field missing within each type, plus the invoice whose VAT is off by 100 UAH and
 * the letter of no registered type. Nothing here is random; the generator's output is a function of this file, the
 * templates and the tools in the image.
 */
export const fixtures: Fixture[] = [
  {
    file: 'invoice-1.pdf',
    type: 'invoice',
    format: 'pdf',
    template: 'invoice',
    writing: { dates: 'dotted', thousands: 'space', currency: 'word' },
    fields: {
      number: 'РФ-0147',
      date: '2026-03-12',
      sellerName: cherry.name,
      sellerEdrpou: cherry.edrpou,
      sellerIban: cherry.iban,
      buyerName: bee.name,
      buyerEdrpou: bee.edrpou,
      currency: 'UAH',
      ...amounts(uah(12500)),
      vatRate: '20%',
      dueDate: '2026-03-26',
      contractRef: 'Д-2026/12 від 01.02.2026',
      paymentPurpose: 'Оплата консультаційних послуг за березень 2026 року',
    },
    expected: accepted,
  },
  {
    file: 'invoice-2.xlsx',
    type: 'invoice',
    format: 'xlsx',
    template: 'invoice',
    writing: { dates: 'dotted', thousands: 'nbsp', currency: 'code' },
    fields: {
      number: 'БД-0032',
      date: '2026-04-03',
      sellerName: bee.name,
      sellerEdrpou: bee.edrpou,
      sellerIban: bee.iban,
      buyerName: crow.name,
      buyerEdrpou: crow.edrpou,
      currency: 'UAH',
      ...amounts(uah(3240, 50)),
      vatRate: '20%',
      dueDate: '2026-04-17',
    },
    expected: accepted,
  },
  {
    // A scan, and the buyer's EDRPOU is not printed on it.
    file: 'invoice-3-scan.pdf',
    type: 'invoice',
    format: 'pdf-scan',
    template: 'invoice',
    writing: { dates: 'worded', thousands: 'space', currency: 'word' },
    fields: {
      number: 'ДЛ-2026-071',
      date: '2026-05-20',
      sellerName: crow.name,
      sellerEdrpou: crow.edrpou,
      sellerIban: crow.iban,
      buyerName: cherry.name,
      currency: 'UAH',
      ...amounts(uah(48000)),
      vatRate: '20%',
      dueDate: '2026-06-03',
      contractRef: 'Д-2026/41 від 22.04.2026',
      paymentPurpose: 'Оплата за перевезення вантажів у травні 2026 року',
    },
    expected: missingField,
  },
  {
    // The VAT printed is 2 100.00 where 20% of the net is 2 000.00, and the gross is the correct 12 000.00: the VAT is
    // off by 100 UAH and the three amounts do not add up.
    file: 'invoice-vat-error.pdf',
    type: 'invoice',
    format: 'pdf',
    template: 'invoice',
    writing: { dates: 'dotted', thousands: 'space', currency: 'word' },
    fields: {
      number: 'РФ-0151',
      date: '2026-06-02',
      sellerName: cherry.name,
      sellerEdrpou: cherry.edrpou,
      sellerIban: cherry.iban,
      buyerName: crow.name,
      buyerEdrpou: crow.edrpou,
      currency: 'UAH',
      totalNet: uah(10000),
      vat: uah(2100),
      totalGross: uah(12000),
      vatRate: '20%',
      dueDate: '2026-06-16',
      contractRef: 'Д-2026/12 від 01.02.2026',
      paymentPurpose: 'Оплата консультаційних послуг за травень 2026 року',
    },
    expected: { status: 'NEEDS_REVIEW', codes: ['VALIDATION_FAILED'] },
  },
  {
    file: 'act-1.png',
    type: 'act',
    format: 'png',
    template: 'act',
    writing: { dates: 'dotted', thousands: 'space', currency: 'word' },
    fields: {
      number: 'ДП-031',
      date: '2026-03-31',
      contractorName: cherry.name,
      contractorEdrpou: cherry.edrpou,
      customerName: crow.name,
      customerEdrpou: crow.edrpou,
      contractRef: 'Д-2026/12 від 01.02.2026',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      currency: 'UAH',
      ...amounts(uah(25000)),
      placeOfSigning: 'м. Дніпро',
    },
    expected: accepted,
  },
  {
    file: 'act-2.jpg',
    type: 'act',
    format: 'jpg',
    template: 'act',
    writing: { dates: 'worded', thousands: 'nbsp', currency: 'word' },
    fields: {
      number: 'ДП-0062',
      date: '2026-04-30',
      contractorName: bee.name,
      contractorEdrpou: bee.edrpou,
      customerName: cherry.name,
      customerEdrpou: cherry.edrpou,
      contractRef: 'Д-2026/27 від 10.03.2026',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      currency: 'UAH',
      ...amounts(uah(7800, 40)),
    },
    expected: accepted,
  },
  {
    // The contract the act refers to is not named on it.
    file: 'act-3.rtf',
    type: 'act',
    format: 'rtf',
    template: 'act',
    writing: { dates: 'dotted', thousands: 'space', currency: 'code' },
    fields: {
      number: 'АВ-117',
      date: '2026-05-31',
      contractorName: crow.name,
      contractorEdrpou: crow.edrpou,
      customerName: bee.name,
      customerEdrpou: bee.edrpou,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      currency: 'UAH',
      ...amounts(uah(61200)),
      placeOfSigning: 'м. Харків',
    },
    expected: missingField,
  },
  {
    file: 'contract-1.svg',
    type: 'contract',
    format: 'svg',
    template: 'contract',
    writing: { dates: 'worded', thousands: 'space', currency: 'word' },
    fields: {
      number: 'Д-2026/12',
      date: '2026-02-01',
      firstPartyName: cherry.name,
      firstPartyEdrpou: cherry.edrpou,
      secondPartyName: bee.name,
      secondPartyEdrpou: bee.edrpou,
      subject: 'Надання консультаційних послуг з автоматизації документообігу',
      currency: 'UAH',
      validFrom: '2026-02-01',
      validUntil: '2026-12-31',
      totalAmount: uah(180000),
      paymentTerms: 'Оплата протягом 14 календарних днів після підписання акта виконаних робіт',
      placeOfSigning: 'м. Дніпро',
    },
    expected: accepted,
  },
  {
    file: 'contract-2.docx',
    type: 'contract',
    format: 'docx',
    template: 'contract',
    writing: { dates: 'dotted', thousands: 'space', currency: 'word' },
    fields: {
      number: 'Д-2026/27',
      date: '2026-03-10',
      firstPartyName: bee.name,
      firstPartyEdrpou: bee.edrpou,
      secondPartyName: crow.name,
      secondPartyEdrpou: crow.edrpou,
      subject: 'Перевезення вантажів автомобільним транспортом по території України',
      currency: 'UAH',
      validFrom: '2026-03-15',
      validUntil: '2027-03-14',
      paymentTerms: 'Післяплата протягом 5 банківських днів після доставки',
      placeOfSigning: 'м. Львів',
    },
    expected: accepted,
  },
  {
    // The date the contract expires is not printed on it.
    file: 'contract-3.doc',
    type: 'contract',
    format: 'doc',
    template: 'contract',
    writing: { dates: 'worded', thousands: 'nbsp', currency: 'code' },
    fields: {
      number: 'Д-2026/41',
      date: '2026-04-22',
      firstPartyName: crow.name,
      firstPartyEdrpou: crow.edrpou,
      secondPartyName: cherry.name,
      secondPartyEdrpou: cherry.edrpou,
      subject: 'Оренда складського приміщення площею 240 кв. м',
      currency: 'UAH',
      validFrom: '2026-05-01',
      totalAmount: uah(96000),
      paymentTerms: 'Щомісячна оплата до 5 числа поточного місяця',
      placeOfSigning: 'м. Харків',
    },
    expected: missingField,
  },
  {
    file: 'letter-untyped.docx',
    type: 'none',
    format: 'docx',
    template: 'letter',
    writing: { dates: 'worded', thousands: 'space', currency: 'word' },
    fields: {
      organisation: cherry.name,
      city: cherry.city,
      date: '14 квітня 2026 р.',
      heading: 'Запрошення на семінар',
      salutation: 'Шановні колеги!',
      paragraphOne: 'Запрошуємо вас на безкоштовний семінар «Облік без паперу: з чого почати», який відбудеться 18 квітня о 11:00 в конференц-залі нашого офісу.',
      paragraphTwo: 'У програмі: короткий огляд сервісів електронного документообігу, відповіді на запитання та кава. Місць небагато, тож просимо повідомити про свою участь.',
      closing: 'З повагою,',
      signatory: 'відділ комунікацій',
    },
    expected: { status: 'NEEDS_REVIEW', codes: ['UNKNOWN_DOC_TYPE'] },
  },
];
