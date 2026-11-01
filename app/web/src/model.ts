import type { FormatParams } from '../../src/shared/format.ts';
import type { LanguageTexts } from '../../src/shared/reason-text.ts';
import { asBoolean, asNullableNumber, asNullableString, asNumber, asObject, asString, mapArray, member } from './shapes.ts';
import type { Obj } from './shapes.ts';

/**
 * The answers of the API as the page uses them (contracts/api.md), each with the parser that builds it from the parsed JSON.
 * A parser reads every member it needs through the narrowing readers of `shapes.ts`, so a view gets a typed value or the
 * page gets an error; nothing is cast. A member the page does not show is not read.
 */

/** A text in both interface languages, read from `{uk, en}`. */
function languageTexts(value: unknown, where: string): LanguageTexts {
  const object = asObject(value, where);
  return { uk: asString(member(object, 'uk'), `${where}.uk`), en: asString(member(object, 'en'), `${where}.en`) };
}

/** The named parameters of a stored reason: strings, numbers and booleans only, which is what a template can take. */
function formatParams(value: unknown, where: string): FormatParams {
  const params: FormatParams = {};
  for (const [name, item] of Object.entries(asObject(value, where))) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${where}.${name}: expected a string, a number or a boolean`);
    }
    params[name] = item;
  }
  return params;
}

/** A field of a registered type, with its label in both languages (`GET /meta`). */
export type MetaField = { name: string; kind: string; labels: LanguageTexts };

/** A registered type with its label and its fields in the registry's order. */
export type MetaType = { name: string; labels: LanguageTexts; fields: MetaField[] };

/** A reason code with its templates, and the variants that replace them for given parameters. */
export type MetaReason = {
  code: string;
  templates: LanguageTexts;
  variants: Array<{ when: FormatParams; templates: LanguageTexts }>;
};

/** What the page derives from the registry and the reasons file, fetched once at load (FR-041, FR-058). */
export type Meta = { types: MetaType[]; reasons: MetaReason[]; statuses: string[]; pageSize: number; pageSizes: number[] };

/** Parses `GET /meta`. */
export function parseMeta(value: unknown): Meta {
  const root = asObject(value, 'meta');
  return {
    types: mapArray(member(root, 'types'), 'meta.types', (item, at) => {
      const type = asObject(item, at);
      return {
        name: asString(member(type, 'name'), `${at}.name`),
        labels: languageTexts(member(type, 'labels'), `${at}.labels`),
        fields: mapArray(member(type, 'fields'), `${at}.fields`, (fieldItem, fieldAt) => {
          const field = asObject(fieldItem, fieldAt);
          return {
            name: asString(member(field, 'name'), `${fieldAt}.name`),
            kind: asString(member(field, 'kind'), `${fieldAt}.kind`),
            labels: languageTexts(member(field, 'labels'), `${fieldAt}.labels`),
          };
        }),
      };
    }),
    reasons: mapArray(member(root, 'reasons'), 'meta.reasons', (item, at) => {
      const reason = asObject(item, at);
      const variants = member(reason, 'variants');
      return {
        code: asString(member(reason, 'code'), `${at}.code`),
        templates: languageTexts(member(reason, 'templates'), `${at}.templates`),
        variants:
          variants === undefined
            ? []
            : mapArray(variants, `${at}.variants`, (variantItem, variantAt) => {
                const variant = asObject(variantItem, variantAt);
                return { when: formatParams(member(variant, 'when'), `${variantAt}.when`), templates: languageTexts(member(variant, 'templates'), `${variantAt}.templates`) };
              }),
      };
    }),
    statuses: mapArray(member(root, 'statuses'), 'meta.statuses', (item, at) => asString(item, at)),
    pageSize: asNumber(member(root, 'pageSize'), 'meta.pageSize'),
    pageSizes: mapArray(member(root, 'pageSizes'), 'meta.pageSizes', (item, at) => asNumber(item, at)),
  };
}

/** One named simplification of the to-do list (FR-052). */
export type Todo = { id: string; uk: string; en: string; trigger: LanguageTexts };

/** `GET /health`: what the header shows (FR-037, FR-052). */
export type Health = { db: string; model: string; sandbox: string; todo: Todo[] };

/** Parses `GET /health`. */
export function parseHealth(value: unknown): Health {
  const root = asObject(value, 'health');
  return {
    db: asString(member(root, 'db'), 'health.db'),
    model: asString(member(root, 'model'), 'health.model'),
    sandbox: asString(member(root, 'sandbox'), 'health.sandbox'),
    todo: mapArray(member(root, 'todo'), 'health.todo', (item, at) => {
      const todo = asObject(item, at);
      return {
        id: asString(member(todo, 'id'), `${at}.id`),
        uk: asString(member(todo, 'uk'), `${at}.uk`),
        en: asString(member(todo, 'en'), `${at}.en`),
        trigger: languageTexts(member(todo, 'trigger'), `${at}.trigger`),
      };
    }),
  };
}

/** A file of the inbox listing. */
export type InboxFile = { name: string; sizeBytes: number; modifiedAt: string };

/** `GET /inbox`. */
export type InboxListing = { path: string; files: InboxFile[] };

/** Parses `GET /inbox`. */
export function parseInbox(value: unknown): InboxListing {
  const root = asObject(value, 'inbox');
  return {
    path: asString(member(root, 'path'), 'inbox.path'),
    files: mapArray(member(root, 'files'), 'inbox.files', (item, at) => {
      const file = asObject(item, at);
      return {
        name: asString(member(file, 'name'), `${at}.name`),
        sizeBytes: asNumber(member(file, 'sizeBytes'), `${at}.sizeBytes`),
        modifiedAt: asString(member(file, 'modifiedAt'), `${at}.modifiedAt`),
      };
    }),
  };
}

/** The result of "Read folder": what was taken, what was a duplicate of which document, and what was skipped and why. */
export type ReadResult = {
  taken: Array<{ number: number; name: string; documentClass: string }>;
  duplicates: Array<{ name: string; originalNumber: number }>;
  skipped: Array<{ name: string; reason: string }>;
};

/** Parses `POST /inbox/read`. */
export function parseReadResult(value: unknown): ReadResult {
  const root = asObject(value, 'read');
  return {
    taken: mapArray(member(root, 'taken'), 'read.taken', (item, at) => {
      const taken = asObject(item, at);
      return {
        number: asNumber(member(taken, 'number'), `${at}.number`),
        name: asString(member(taken, 'name'), `${at}.name`),
        documentClass: asString(member(taken, 'class'), `${at}.class`),
      };
    }),
    duplicates: mapArray(member(root, 'duplicates'), 'read.duplicates', (item, at) => {
      const duplicate = asObject(item, at);
      return { name: asString(member(duplicate, 'name'), `${at}.name`), originalNumber: asNumber(member(duplicate, 'originalNumber'), `${at}.originalNumber`) };
    }),
    skipped: mapArray(member(root, 'skipped'), 'read.skipped', (item, at) => {
      const skipped = asObject(item, at);
      return { name: asString(member(skipped, 'name'), `${at}.name`), reason: asString(member(skipped, 'reason'), `${at}.reason`) };
    }),
  };
}

/** The answer to an upload: a new document, or the number of the document that already has these bytes. */
export type UploadResult = { kind: 'new'; number: number } | { kind: 'duplicate'; originalNumber: number };

/** Parses the body of `POST /documents`; a body with `code: DUPLICATE` is the duplicate answer. */
export function parseUploadResult(value: unknown): UploadResult {
  const root = asObject(value, 'upload');
  if (member(root, 'code') === 'DUPLICATE') {
    return { kind: 'duplicate', originalNumber: asNumber(member(root, 'originalNumber'), 'upload.originalNumber') };
  }
  return { kind: 'new', number: asNumber(member(root, 'number'), 'upload.number') };
}

/** A reason as stored: a code and its parameters, never a message. */
export type StoredReason = { code: string; params: FormatParams };

/** Reads one `{code, params}`. */
function storedReason(item: unknown, at: string): StoredReason {
  const reason = asObject(item, at);
  return { code: asString(member(reason, 'code'), `${at}.code`), params: formatParams(member(reason, 'params'), `${at}.params`) };
}

/** A row of the documents table. */
export type ListedDocument = {
  number: number;
  originalName: string | null;
  documentClass: string;
  type: string | null;
  status: string;
  reasons: StoredReason[];
};

/** `GET /documents`: one page of rows, with the page's own `limit` and `offset` and the total `count` of documents. */
export type DocumentList = { documents: ListedDocument[]; count: number; limit: number; offset: number };

/** Parses `GET /documents`. */
export function parseDocumentList(value: unknown): DocumentList {
  const root = asObject(value, 'documents');
  return {
    count: asNumber(member(root, 'count'), 'documents.count'),
    limit: asNumber(member(root, 'limit'), 'documents.limit'),
    offset: asNumber(member(root, 'offset'), 'documents.offset'),
    documents: mapArray(member(root, 'documents'), 'documents.documents', (item, at) => {
      const row = asObject(item, at);
      return {
        number: asNumber(member(row, 'number'), `${at}.number`),
        originalName: asNullableString(member(row, 'originalName'), `${at}.originalName`),
        documentClass: asString(member(row, 'class'), `${at}.class`),
        type: asNullableString(member(row, 'type'), `${at}.type`),
        status: asString(member(row, 'status'), `${at}.status`),
        reasons: mapArray(member(row, 'reasons'), `${at}.reasons`, storedReason),
      };
    }),
  };
}

/** A field of the detail view with the evidence of its value. */
export type DetailField = {
  name: string;
  kind: string;
  value: unknown;
  verbatim: string | null;
  page: number | null;
  found: boolean;
};

/** The detail view of one document (`GET /documents/{number}`). */
export type DocumentDetail = {
  number: number;
  sha256: string;
  originalName: string | null;
  documentClass: string;
  type: string | null;
  status: string;
  reasons: StoredReason[];
  fields: DetailField[];
  pages: Array<{ page: number; width: number; height: number; source: string | null }>;
  steps: Array<{ step: string; attempt: number; outcome: string | null; durationMs: number | null }>;
  model: { name: string; digest: string; promptHash: string; schemaId: string | null; promptEvalCount: number | null; evalCount: number | null; cold: boolean } | null;
};

/** Parses `GET /documents/{number}`. */
export function parseDocumentDetail(value: unknown): DocumentDetail {
  const root = asObject(value, 'detail');
  const model = member(root, 'model');
  const readModel = (object: Obj) => ({
    name: asString(member(object, 'name'), 'detail.model.name'),
    digest: asString(member(object, 'digest'), 'detail.model.digest'),
    promptHash: asString(member(object, 'promptHash'), 'detail.model.promptHash'),
    schemaId: asNullableString(member(object, 'schemaId'), 'detail.model.schemaId'),
    promptEvalCount: asNullableNumber(member(object, 'promptEvalCount'), 'detail.model.promptEvalCount'),
    evalCount: asNullableNumber(member(object, 'evalCount'), 'detail.model.evalCount'),
    cold: asBoolean(member(object, 'cold'), 'detail.model.cold'),
  });
  return {
    number: asNumber(member(root, 'number'), 'detail.number'),
    sha256: asString(member(root, 'sha256'), 'detail.sha256'),
    originalName: asNullableString(member(root, 'originalName'), 'detail.originalName'),
    documentClass: asString(member(root, 'class'), 'detail.class'),
    type: asNullableString(member(root, 'type'), 'detail.type'),
    status: asString(member(root, 'status'), 'detail.status'),
    reasons: mapArray(member(root, 'reasons'), 'detail.reasons', storedReason),
    fields: mapArray(member(root, 'fields'), 'detail.fields', (item, at) => {
      const field = asObject(item, at);
      return {
        name: asString(member(field, 'name'), `${at}.name`),
        kind: asString(member(field, 'kind'), `${at}.kind`),
        value: member(field, 'value'),
        verbatim: asNullableString(member(field, 'verbatim'), `${at}.verbatim`),
        page: asNullableNumber(member(field, 'page'), `${at}.page`),
        found: asBoolean(member(field, 'found'), `${at}.found`),
      };
    }),
    pages: mapArray(member(root, 'pages'), 'detail.pages', (item, at) => {
      const page = asObject(item, at);
      return {
        page: asNumber(member(page, 'page'), `${at}.page`),
        width: asNumber(member(page, 'width'), `${at}.width`),
        height: asNumber(member(page, 'height'), `${at}.height`),
        source: asNullableString(member(page, 'source'), `${at}.source`),
      };
    }),
    steps: mapArray(member(root, 'steps'), 'detail.steps', (item, at) => {
      const step = asObject(item, at);
      return {
        step: asString(member(step, 'step'), `${at}.step`),
        attempt: asNumber(member(step, 'attempt'), `${at}.attempt`),
        outcome: asNullableString(member(step, 'outcome'), `${at}.outcome`),
        durationMs: asNullableNumber(member(step, 'durationMs'), `${at}.durationMs`),
      };
    }),
    model: model === null ? null : readModel(asObject(model, 'detail.model')),
  };
}

/** One model call with what was sent and what came back, as the collapsed block shows it. */
export type RawCall = { id: number; kind: string; attempt: number; doneReason: string | null; rawRequest: unknown; rawResponse: unknown };

/** Parses `GET /documents/{number}/raw`. */
export function parseRaw(value: unknown): RawCall[] {
  const root = asObject(value, 'raw');
  return mapArray(member(root, 'extractions'), 'raw.extractions', (item, at) => {
    const call = asObject(item, at);
    return {
      id: asNumber(member(call, 'id'), `${at}.id`),
      kind: asString(member(call, 'kind'), `${at}.kind`),
      attempt: asNumber(member(call, 'attempt'), `${at}.attempt`),
      doneReason: asNullableString(member(call, 'doneReason'), `${at}.doneReason`),
      rawRequest: member(call, 'rawRequest'),
      rawResponse: member(call, 'rawResponse'),
    };
  });
}
