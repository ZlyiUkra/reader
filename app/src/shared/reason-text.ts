import { format } from './format.ts';
import type { FormatParams } from './format.ts';

/**
 * Which template a stored reason is shown with, and the filling of it. The server renders messages for its own use and
 * the page renders them in the browser from the templates of `GET /api/meta`; both go through this one function, so a
 * variant can never be chosen differently on the two sides (FR-025, FR-058, research R9, R10).
 */

/** A text in each of the two interface languages. */
export type LanguageTexts = { uk: string; en: string };

/** The language keys a text can be taken in. */
export type TextLanguage = keyof LanguageTexts;

/** A reason entry as far as rendering needs it: the base templates and the variants that replace them for given params. */
export type ReasonTexts = {
  templates: LanguageTexts;
  variants?: Array<{ when: Record<string, string | number | boolean>; templates: LanguageTexts }> | undefined;
};

/**
 * The message of a reason in one language: the templates of the first variant whose `when` entries all equal the params,
 * else the base templates, with the placeholders filled in one pass (`format`). The result is text, never markup.
 */
export function renderReason(entry: ReasonTexts, params: FormatParams, lang: TextLanguage): string {
  const variant = (entry.variants ?? []).find((candidate) =>
    Object.entries(candidate.when).every(([name, value]) => Object.hasOwn(params, name) && params[name] === value),
  );
  return format((variant ?? entry).templates[lang], params);
}
