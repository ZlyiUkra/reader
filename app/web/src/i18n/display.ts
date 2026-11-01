import type { FormatParams } from '@shared/format.ts';
import { renderReason } from '@shared/reason-text.ts';
import { formatKopiyky } from '@shared/values.ts';
import type { Meta, MetaType, StoredReason } from '../api/answers.ts';
import { translateName } from './t.ts';
import type { Lang } from './t.ts';

/**
 * What the page shows for names that come from the server: the label of a type or a field, the message of a reason and the
 * text of a typed value. Labels and templates are not kept in the page: they come from `GET /api/meta` in both languages
 * and the active one is taken here, so a new type or a reworded reason needs no change to the page (FR-041, FR-058). All
 * results are plain strings; the views set them as text, never as markup (FR-055).
 */

/** The registered type with this name, if the registry has it. */
export function typeOf(meta: Meta, name: string | null): MetaType | undefined {
  return name === null ? undefined : meta.types.find((type) => type.name === name);
}

/** The label of a type in the active language; a type the registry no longer has shows under its own name. */
export function typeLabel(meta: Meta, name: string | null, lang: Lang): string {
  return typeOf(meta, name)?.labels[lang] ?? name ?? '';
}

/** The label of a field of a type in the active language; an unknown field shows under its own name. */
export function fieldLabel(meta: Meta, typeName: string | null, fieldName: string, lang: Lang): string {
  return typeOf(meta, typeName)?.fields.find((field) => field.name === fieldName)?.labels[lang] ?? fieldName;
}

/** The parameters of a reason that hold a field name: shown as the field's label, which is what the owner knows it by. */
const fieldNameParams = ['field', 'earlier', 'later'];

/**
 * The parameters of a reason that hold a technical name the code stores: the program that could not read the file, the limit
 * that was breached and the cause of an internal error. Each is shown under the name the page's dictionary gives it, in the
 * group called like the parameter (`tool.soffice`, `limit.page_cap`, `cause.model_timeout`), and as stored when the
 * dictionary has no name for it, so a value added to the code later still shows something readable to a developer.
 */
const technicalNameParams = ['tool', 'limit', 'cause'];

/**
 * The message of a stored reason in the active language, made of the template and the stored parameters. A parameter that
 * names a field of the document's type is replaced by that field's label in the same language, so the owner reads the label
 * and not the name the schema uses, and a technical name (program, limit, cause) by its name from the dictionary; a reason
 * code the page does not know is shown as its code.
 */
export function reasonText(meta: Meta, reason: StoredReason, typeName: string | null, lang: Lang): string {
  const entry = meta.reasons.find((candidate) => candidate.code === reason.code);
  if (entry === undefined) {
    return reason.code;
  }
  const params: FormatParams = { ...reason.params };
  for (const name of fieldNameParams) {
    const value = params[name];
    if (typeof value === 'string') {
      params[name] = fieldLabel(meta, typeName, value, lang);
    }
  }
  for (const name of technicalNameParams) {
    const value = params[name];
    if (typeof value === 'string') {
      params[name] = translateName(lang, name, value);
    }
  }
  return renderReason(entry, params, lang);
}

/** A typed value as text: money as an amount with its currency, everything else as it is stored; null shows as nothing. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object' && 'amount' in value && typeof value.amount === 'number') {
    const currency = 'currency' in value && typeof value.currency === 'string' ? ` ${value.currency}` : '';
    return `${formatKopiyky(value.amount)}${currency}`;
  }
  return JSON.stringify(value);
}

/** A moment from the server in the format of the active language, in the browser's own time zone. */
export function timeText(iso: string, lang: Lang): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB');
}
