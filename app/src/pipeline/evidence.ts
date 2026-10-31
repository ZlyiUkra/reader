import type { ExtractionRow, PageReading } from '../db/queries.ts';
import type { FieldKind, RegistryField, RegistryType } from '../registry/registry.ts';
import { normalizeFragment, normalizeText, originalRange } from '../shared/normalize.ts';
import type { Normalized } from '../shared/normalize.ts';
import { matchEnum, parseCurrency, parseDate, parseEdrpou, parseIban, parseMoney } from '../shared/values.ts';
import { isRecord, ModelReplyError } from './model-call.ts';

/**
 * Evidence (FR-018, FR-019, constitution V and VI): for every field the model quoted a fragment of the document, and the
 * pipeline, not the model, finds that fragment in the stored page texts under the pinned normalisation, computes the page
 * and the offsets itself, and derives the typed value from the fragment. A fragment that is not found is not evidence and
 * the field is not accepted; the model's own value and page stay only in the stored reply. Everything here is a pure
 * function of the registry type, the stored reply and the stored page texts, so the same inputs give the same rows.
 */

/** What the model wrote for one field: the quoted fragment and the page it named, both null when it reported the field absent. */
export type Quote = {
  verbatim: string | null;
  page: number | null;
};

/** Where a fragment was found: the reading, its page, and the character range in the stored text of that reading. */
export type Located = {
  pageTextId: number;
  pageNo: number;
  start: number;
  end: number;
};

/**
 * How far a field got: `absent` (the model reported it missing), `not-located` (it quoted a fragment that is not in the
 * text), `unreadable` (the fragment is in the text but is not a value of the field's kind) or `ok`.
 */
export type FieldState = 'absent' | 'not-located' | 'unreadable' | 'ok';

/**
 * A typed value derived from a fragment: `stored` is what the `fields` row keeps (money as amount and currency, as the data
 * model says), `canonical` is the value as the type schema states it (money as an integer of kopiyky), which is what the
 * checks and the schema validation work on.
 */
export type TypedValue = {
  stored: unknown;
  canonical: string | number;
};

/** One field with everything the pipeline found out about it. */
export type FieldEvidence = {
  name: string;
  kind: FieldKind;
  state: FieldState;
  verbatim: string | null;
  claimedPage: number | null;
  located: Located | null;
  value: TypedValue | null;
};

/**
 * Reads back the JSON the model wrote from the stored raw reply. The raw reply is the model server's own body, exactly as
 * it came (C12), and the written JSON sits in `message.content` of a chat reply or `response` of a generate reply; the
 * request that was stored says which. The page the model named is kept only there, and the reason a fragment is not found
 * needs it.
 */
export function storedReply(extraction: ExtractionRow): unknown {
  const endpoint = extraction.raw_request['endpoint'];
  const response = extraction.raw_response;
  let content: unknown;
  if (endpoint === '/api/chat') {
    const message = response['message'];
    content = isRecord(message) ? message['content'] : undefined;
  } else if (endpoint === '/api/generate') {
    content = response['response'];
  }
  if (typeof content !== 'string') {
    throw new ModelReplyError(`The stored reply of extraction ${extraction.id} has no content to read back.`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new ModelReplyError(`The stored reply of extraction ${extraction.id} is not JSON.`);
  }
}

/** The quotes of a reply, one per field of the type; a reply that does not have the wire shape is a defect and stops here. */
export function quotesOf(type: RegistryType, reply: unknown): Map<string, Quote> {
  if (!isRecord(reply)) {
    throw new ModelReplyError('The extraction reply is not an object.');
  }
  const quotes = new Map<string, Quote>();
  for (const field of type.fields) {
    const entry = reply[field.name];
    const verbatim = isRecord(entry) ? entry['verbatim'] : undefined;
    const page = isRecord(entry) ? entry['page'] : undefined;
    if ((typeof verbatim !== 'string' && verbatim !== null) || (!(typeof page === 'number' && Number.isInteger(page)) && page !== null)) {
      throw new ModelReplyError(`The extraction reply has no quote for the field ${field.name}.`);
    }
    quotes.set(field.name, { verbatim, page });
  }
  return quotes;
}

/** A page reading after normalisation, with the map back to its stored text. */
type NormalizedReading = {
  reading: PageReading;
  normalized: Normalized;
};

/**
 * Finds a quoted fragment in the page texts. The fragment and each text go through the same normalisation, so an apostrophe
 * variant, a non-breaking space or a word broken at a line end does not make a true quote fail, and a different word still
 * does (C11). The page the model named is tried first, because a figure often repeats on several pages and the named page is
 * the likelier one; a fragment found elsewhere is still found, on the page where it really is. The offsets are mapped back to
 * the stored text, which is not changed.
 */
function locate(readings: NormalizedReading[], fragment: string, claimedPage: number | null): Located | null {
  const needle = normalizeFragment(fragment);
  if (needle === '') {
    return null;
  }
  const ordered = [...readings].sort((a, b) => Number(b.reading.pageNo === claimedPage) - Number(a.reading.pageNo === claimedPage) || a.reading.pageNo - b.reading.pageNo);
  for (const { reading, normalized } of ordered) {
    const index = normalized.text.indexOf(needle);
    if (index >= 0) {
      const range = originalRange(normalized, index, index + needle.length);
      return { pageTextId: reading.pageTextId, pageNo: reading.pageNo, start: range.start, end: range.end };
    }
  }
  return null;
}

/** The values an `enum` field may take, from the property of the canonical schema. */
function allowedValues(type: RegistryType, field: RegistryField): string[] {
  const properties: unknown = type.schema['properties'];
  const definition = isRecord(properties) ? properties[field.name] : undefined;
  const list = isRecord(definition) ? definition['enum'] : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The typed value of a located fragment (FR-019), or null when the fragment is not a value of the field's kind. A currency
 * written as a sign or a word is matched through the table of currencies; any other enumeration must equal a member.
 */
export function deriveValue(type: RegistryType, field: RegistryField, fragment: string): TypedValue | null {
  switch (field.kind) {
    case 'string': {
      const text = normalizeFragment(fragment);
      return text === '' ? null : { stored: text, canonical: text };
    }
    case 'date': {
      const date = parseDate(fragment);
      return date === null ? null : { stored: date, canonical: date };
    }
    case 'money': {
      const money = parseMoney(fragment);
      return money === null ? null : { stored: { amount: money.minor, currency: money.currency }, canonical: money.minor };
    }
    case 'enum': {
      const allowed = allowedValues(type, field);
      const member = parseCurrency(fragment, allowed) ?? matchEnum(fragment, allowed);
      return member === null ? null : { stored: member, canonical: member };
    }
    case 'edrpou': {
      const code = parseEdrpou(fragment);
      return code === null ? null : { stored: code, canonical: code };
    }
    case 'iban': {
      const iban = parseIban(fragment);
      return iban === null ? null : { stored: iban, canonical: iban };
    }
  }
}

/**
 * Turns the model's quotes and the stored page texts into the evidence of every field of the type, in the order of the
 * registry. Nothing the model said about a value or a page is trusted: a quote counts only where the pipeline finds it.
 */
export function gatherEvidence(type: RegistryType, quotes: Map<string, Quote>, readings: PageReading[]): FieldEvidence[] {
  const normalized = readings.map((reading): NormalizedReading => ({ reading, normalized: normalizeText(reading.text) }));
  return type.fields.map((field): FieldEvidence => {
    const quote = quotes.get(field.name) ?? { verbatim: null, page: null };
    const base = { name: field.name, kind: field.kind, verbatim: quote.verbatim, claimedPage: quote.page };
    if (quote.verbatim === null || quote.verbatim.trim() === '') {
      return { ...base, state: 'absent', located: null, value: null };
    }
    const located = locate(normalized, quote.verbatim, quote.page);
    if (located === null) {
      return { ...base, state: 'not-located', located: null, value: null };
    }
    const value = deriveValue(type, field, quote.verbatim);
    return { ...base, state: value === null ? 'unreadable' : 'ok', located, value };
  });
}
