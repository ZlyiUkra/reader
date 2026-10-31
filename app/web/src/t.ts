import uk from './i18n/uk.json';
import en from './i18n/en.json';
import { format } from '../../src/shared/format.ts';
import type { FormatParams } from '../../src/shared/format.ts';

/**
 * The page's own texts in the two interface languages (FR-057, FR-058, research R9). Field labels and reason templates
 * are not here: they arrive from `GET /api/meta` in both languages and the page picks the active one at render time.
 */
export const languages = ['uk', 'en'] as const;
export type Lang = (typeof languages)[number];

/** Every key of the Ukrainian dictionary; the English one must have exactly these keys, which the type below enforces. */
export type TextKey = keyof typeof uk;

const dictionaries: Record<Lang, Record<TextKey, string>> = { uk, en };

/** Where the browser remembers the chosen language between visits; the server keeps no per-user state (FR-057). */
const storageKey = 'reader.lang';

/** The language used when nothing valid is stored: Ukrainian is the default and English stays one switch away. */
const defaultLang: Lang = 'uk';

/** Narrows an arbitrary stored string to a language of the closed list. */
function isLang(value: unknown): value is Lang {
  return languages.some((lang) => lang === value);
}

/**
 * Reads the remembered language. Browser storage can be absent or refuse access (blocked site data, some private
 * windows), and that is not an error of the page: the default applies and the page works without memory.
 */
export function readLang(): Lang {
  try {
    const stored = localStorage.getItem(storageKey);
    if (isLang(stored)) {
      return stored;
    }
  } catch {
    // Storage is unavailable; fall through to the default.
  }
  return defaultLang;
}

/** Remembers the chosen language; silently skipped when storage is unavailable, for the reason given at `readLang`. */
export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(storageKey, lang);
  } catch {
    // Storage is unavailable; the choice then lasts until the page is closed.
  }
}

/** Looks a text up in the dictionary of `lang` and fills its placeholders with the formatter shared with the server. */
export function translate(lang: Lang, key: TextKey, params?: FormatParams): string {
  return format(dictionaries[lang][key], params);
}
