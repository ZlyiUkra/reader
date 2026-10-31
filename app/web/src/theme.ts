/**
 * The two colour themes of the page, in the order the one-button switch cycles through them. Which one is shown is the
 * owner's choice and is kept in the browser only; there is no per-user state on the server (as for the language, FR-057).
 */
export const themes = ['light', 'dark'] as const;
export type Theme = (typeof themes)[number];

/** Where the browser remembers the chosen theme between visits. */
const storageKey = 'reader.theme';

/** The theme used when nothing valid is stored: dark, by the owner's decision; the system setting is not consulted. */
const defaultTheme: Theme = 'dark';

/** The theme the one-button switch changes to: the next of the closed list, which with two themes is the other one. */
export function nextTheme(theme: Theme): Theme {
  return themes[(themes.indexOf(theme) + 1) % themes.length];
}

/** Narrows an arbitrary stored string to a theme of the closed list. */
function isTheme(value: unknown): value is Theme {
  return themes.some((theme) => theme === value);
}

/**
 * Reads the remembered theme. Browser storage can be absent or refuse access (blocked site data, some private
 * windows), and that is not an error of the page: the default applies and the page works without memory.
 */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(storageKey);
    if (isTheme(stored)) {
      return stored;
    }
  } catch {
    // Storage is unavailable; fall through to the default.
  }
  return defaultTheme;
}

/** Remembers the chosen theme; silently skipped when storage is unavailable, for the reason given at `readTheme`. */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Storage is unavailable; the choice then lasts until the page is closed.
  }
}

/** Puts the theme on the root element, where the stylesheet reads it; the dark values are the stylesheet's default. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
