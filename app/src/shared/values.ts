import { normalizeFragment } from './normalize.ts';

/**
 * The typed value of a field, derived from the located fragment by the pipeline and never taken from the model's own
 * value (FR-019, constitution V). Every function returns `null` for a fragment it does not understand, and the caller
 * turns that into a reason: a value that cannot be read is not accepted (constitution VI). Formats are those pinned in
 * contracts/type-schema.md and research R13.
 */

/** The twelve months in the genitive case, as Ukrainian dates are written ("01 березня 2026 р."). */
const monthsGenitive = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** Days in a month of the Gregorian calendar. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Builds the ISO date when the day, month and year form a real calendar date, otherwise `null`. */
function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Reads a date written as `DD.MM.YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD` or with a Ukrainian month name in the genitive
 * (`1 березня 2026`, with or without the trailing `р.` or `року`) and returns it as an ISO date. A day or month may be
 * written with one digit. A date that does not exist (the 30th of February) is `null`.
 */
export function parseDate(fragment: string): string | null {
  const text = normalizeFragment(fragment).toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) {
    return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const numeric = /^(\d{1,2})([./])(\d{1,2})\2(\d{4})(?: ?(?:р\.?|року))?$/u.exec(text);
  if (numeric !== null) {
    return isoDate(Number(numeric[4]), Number(numeric[3]), Number(numeric[1]));
  }
  const worded = /^(\d{1,2}) ([а-яіїєґ]+) (\d{4})(?: ?(?:р\.?|року))?$/u.exec(text);
  if (worded !== null) {
    const month = monthsGenitive.indexOf(worded[2] ?? '') + 1;
    return month === 0 ? null : isoDate(Number(worded[3]), month, Number(worded[1]));
  }
  return null;
}

/** The currencies the prototype reads (owner decision of 2026-10-31); each has 100 minor units to the unit. */
export const currencies = ['UAH', 'EUR', 'USD'] as const;
export type Currency = (typeof currencies)[number];

/**
 * How each currency is written on a document: its code, its sign or its name. The table is closed on purpose, so a
 * currency is recognised by what is written and never guessed; a new spelling is added here together with a test.
 */
const currencyWritings: Record<Currency, string[]> = {
  UAH: ['UAH', 'грн', 'грн.', '₴', 'гривня', 'гривні', 'гривень'],
  EUR: ['EUR', '€', 'євро'],
  USD: ['USD', 'US$', '$', 'дол.', 'долар', 'долари', 'доларів'],
};

/** Every writing with the currency it stands for, longest first, so `US$` is taken before `$` and `грн.` before `грн`. */
const writings = Object.entries(currencyWritings)
  .flatMap(([code, spellings]) => spellings.map((spelling) => ({ code: code as Currency, spelling: spelling.toLowerCase() })))
  .sort((a, b) => b.spelling.length - a.spelling.length);

/**
 * Reads the value of a `currency` field: the fragment must be one of the writings of a currency that the field's schema
 * allows. `грн` is `UAH` only if `UAH` is among `allowed`; a writing the table does not know is `null`.
 */
export function parseCurrency(fragment: string, allowed: string[]): string | null {
  const text = normalizeFragment(fragment).toLowerCase();
  const found = writings.find((writing) => writing.spelling === text);
  return found !== undefined && allowed.includes(found.code) ? found.code : null;
}

/** An amount in the minor unit of its currency, with the currency the fragment itself names, or `null` when it names none. */
export type Money = {
  minor: number;
  currency: Currency | null;
};

/**
 * Reads an amount and returns it as an integer count of minor units (kopiyky, cents) together with the currency written
 * next to it, before or after the number, if any. Thousands are separated by spaces (the non-breaking ones are normalised
 * to spaces first) and the decimal mark is a comma or a dot with one or two digits. Anything else is `null`: a negative
 * number, a currency outside the table, a decimal part of three digits (which would be a thousands separator in English
 * writing, so it is not guessed), a number too large to hold exactly. Money is never a float (C11). Whether the currency
 * written here is the document's own currency is a check of the pipeline, which has both.
 */
export function parseMoney(fragment: string): Money | null {
  let text = normalizeFragment(fragment);
  let currency: Currency | null = null;
  const lower = text.toLowerCase();
  const trailing = writings.find((writing) => lower.endsWith(writing.spelling));
  const leading = writings.find((writing) => lower.startsWith(writing.spelling));
  if (trailing !== undefined) {
    currency = trailing.code;
    text = text.slice(0, text.length - trailing.spelling.length).trim();
  } else if (leading !== undefined) {
    currency = leading.code;
    text = text.slice(leading.spelling.length).trim();
  }
  const parts = /^(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (parts === null || parts[1] === undefined) {
    return null;
  }
  const whole = parts[1].replace(/ /g, '');
  if (whole.length > 13) {
    return null;
  }
  return { minor: Number(whole) * 100 + Number((parts[2] ?? '').padEnd(2, '0') || '0'), currency };
}

/** The value of an enumeration field: the fragment must equal one of the allowed values exactly after normalisation. Currencies go through `parseCurrency`. */
export function matchEnum(fragment: string, allowed: string[]): string | null {
  const text = normalizeFragment(fragment);
  return allowed.find((value) => value === text) ?? null;
}

/** An EDRPOU code written with or without spaces: eight digits, or `null`. Whether the check digit verifies is a check. */
export function parseEdrpou(fragment: string): string | null {
  const text = normalizeFragment(fragment).replace(/ /g, '');
  return /^[0-9]{8}$/.test(text) ? text : null;
}

/** A Ukrainian IBAN written in groups: spaces removed, upper case, `UA` and 27 digits, or `null`. Whether it verifies is a check. */
export function parseIban(fragment: string): string | null {
  const text = normalizeFragment(fragment).replace(/ /g, '').toUpperCase();
  return /^UA[0-9]{27}$/.test(text) ? text : null;
}

/**
 * The VAT due on a net amount, in kopiyky, rounded half up to a whole kopiyka with integer arithmetic only, so the
 * comparison with the VAT printed on the document is exact and a tolerance cannot let a wrong invoice through (C11).
 */
export function vatOf(netKopiyky: number, ratePercent: number): number {
  const scaled = netKopiyky * ratePercent + 50;
  return (scaled - (scaled % 100)) / 100;
}

/** The `vat_sum` rule: net plus VAT equals gross, and VAT equals the VAT due at the rate, all exactly in kopiyky. */
export function vatSumHolds(netKopiyky: number, vatKopiyky: number, grossKopiyky: number, ratePercent: number): boolean {
  return netKopiyky + vatKopiyky === grossKopiyky && vatKopiyky === vatOf(netKopiyky, ratePercent);
}

/** An amount of kopiyky written as a decimal string with two places, with integer arithmetic only: 1200050 is "12000.50". */
export function formatKopiyky(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
