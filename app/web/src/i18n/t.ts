import uk from './uk.json';
import en from './en.json';
import { format } from '@shared/format.ts';
import type { FormatParams } from '@shared/format.ts';

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

/** The language the one-button switch changes to: the next of the closed list, which with two languages is the other one. */
export function nextLang(lang: Lang): Lang {
  return languages[(languages.indexOf(lang) + 1) % languages.length];
}

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

/** True when `key` is a key of the dictionary; texts whose key is built from data (a status, a step) are looked up with it. */
function isTextKey(key: string): key is TextKey {
  return Object.hasOwn(uk, key);
}

/**
 * The text under `<group>.<name>` in the active language, or the name itself when the dictionary has none. A status, step or
 * outcome the page was not written for therefore shows as it is, instead of as an empty cell or a raw key.
 */
export function translateName(lang: Lang, group: string, name: string): string {
  const key = `${group}.${name}`;
  return isTextKey(key) ? translate(lang, key) : name;
}
