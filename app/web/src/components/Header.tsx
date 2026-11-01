import React from 'react';
import { poll } from '../api.ts';
import { parseHealth } from '../model.ts';
import type { Health } from '../model.ts';
import { nextLang, translate, translateName } from '../t.ts';
import type { Lang, TextKey } from '../t.ts';
import { nextTheme } from '../theme.ts';
import type { Theme } from '../theme.ts';

/**
 * What the language button shows, keyed by the language it switches to: that language's own code, which reads the same
 * in both languages. Showing the target and not the current language tells the user what a click will do.
 */
const languageLabels: Record<Lang, string> = { uk: 'UK', en: 'EN' };

/** Dictionary key of the action of the language button, keyed by the language it switches to; it names the button. */
const languageTexts: Record<Lang, TextKey> = { uk: 'header.langToUk', en: 'header.langToEn' };

/** Dictionary key of the action of the theme button, keyed by the theme it switches to; it names the button. */
const themeTexts: Record<Theme, TextKey> = { light: 'header.themeToLight', dark: 'header.themeToDark' };

/**
 * What the theme button shows, keyed by the theme it switches to: a sun for the light theme and a moon for the dark one.
 * They are drawn inline so the page needs no image file and no dependency, take the text colour of the button, and are
 * hidden from screen readers because the button carries the name.
 */
const themeIcons: Record<Theme, React.JSX.Element> = {
  light: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
};

/** The header takes the active language and theme and a way to change each; both live in `App`, which owns the page. */
type HeaderProps = {
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
};

/**
 * Top bar of the page: the title, the theme button and the language button (FR-057). Each is one button that switches
 * to the other value of its closed list and shows that other value, a sun or a moon for the theme and a language code
 * for the language. Its name, which a screen reader reads and the tooltip shows, says the action in the active language.
 * Beside them it shows what `GET /api/health` reports, polled every two seconds: the database, the model, the sandbox
 * runtime, and the list of named simplifications of the prototype with what ends each one (FR-052, constitution XII). The
 * list is one line with its count until the owner opens it; every text of it is set as text, in the active language.
 */
export function Header({ lang, onLangChange, theme, onThemeChange }: HeaderProps): React.JSX.Element {
  const toLang = nextLang(lang);
  const toTheme = nextTheme(theme);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [unreachable, setUnreachable] = React.useState(false);

  React.useEffect(
    () =>
      poll(
        'health',
        2000,
        parseHealth,
        (data) => {
          setHealth(data);
          setUnreachable(false);
        },
        () => setUnreachable(true),
      ),
    [],
  );

  return (
    <header className="header">
      <h1>{translate(lang, 'app.title')}</h1>
      <ul className="health" aria-label={translate(lang, 'header.health')}>
        {health === null ? null : (
          <>
            <li data-state={health.db}>{translate(lang, 'header.db', { state: translateName(lang, 'health.db', health.db) })}</li>
            <li data-state={health.model}>{translate(lang, 'header.model', { state: translateName(lang, 'health.model', health.model) })}</li>
            <li>{translate(lang, 'header.sandbox', { runtime: health.sandbox })}</li>
          </>
        )}
        {unreachable ? <li data-state="down">{translate(lang, 'header.unreachable')}</li> : null}
      </ul>
      <div className="controls">
        <button
          type="button"
          aria-label={translate(lang, themeTexts[toTheme])}
          title={translate(lang, themeTexts[toTheme])}
          onClick={() => onThemeChange(toTheme)}
        >
          {themeIcons[toTheme]}
        </button>
        <button
          type="button"
          aria-label={translate(lang, languageTexts[toLang])}
          title={translate(lang, languageTexts[toLang])}
          onClick={() => onLangChange(toLang)}
        >
          {languageLabels[toLang]}
        </button>
      </div>
      {health === null ? null : (
        <details className="todo">
          <summary>{translate(lang, 'header.todo', { count: health.todo.length })}</summary>
          <ul>
            {health.todo.map((item) => (
              <li key={item.id}>
                <span>{item[lang]}</span> <span className="muted">{translate(lang, 'header.todo.trigger', { trigger: item.trigger[lang] })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </header>
  );
}
