/**
 * Values a template can take: the stored `params` of a reason are JSON, so strings, numbers and booleans (data-model.md,
 * `reasons.params`).
 */
export type FormatParams = Record<string, string | number | boolean>;

/** A `{name}` placeholder: a letter, then letters and digits, the same shape the reasons contract allows for parameter names. */
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * Names of the placeholders a template contains, in order of appearance. Used to check at start that a template only
 * names parameters its entry declares.
 */
export function placeholders(template: string): string[] {
  return [...template.matchAll(placeholderPattern)].map((match) => match[1] ?? '');
}

/**
 * Substitutes `{name}` placeholders in one pass over the template only, so a value that itself contains `{other}` (a
 * quoted fragment of a document, say) is never expanded a second time. A placeholder without a value stays as written,
 * which makes a missing parameter visible instead of blank. The page and the server share this function (research
 * R9, R10); the result is text and the page sets it as text content, never as HTML (FR-055).
 */
export function format(template: string, params: FormatParams = {}): string {
  return template.replace(placeholderPattern, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}
