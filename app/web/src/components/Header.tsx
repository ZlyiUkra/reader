import React from 'react';
import type { Health } from '../api/answers.ts';
import { nextLang, translate, translateName } from '../i18n/t.ts';
import type { Lang, TextKey } from '../i18n/t.ts';
import { navigate } from '../router.ts';
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

/**
 * What one state indicator shows and says: the acronym drawn in the box, the state that colours the box (the value the
 * server reported, or `info` for a box that reports no state) and the tooltip, which is also the name a screen reader reads.
 */
type IndicatorProps = {
  acronym: string;
  state: string;
  tip: string;
};

/**
 * One box of the row of state indicators (FR-065). The acronym is the same in both languages, like the codes of the language
 * button; the colour comes from the state and is never the only sign, since the acronym is always written; the tooltip, in the
 * page language, says what the element is and what its state means.
 */
function Indicator({ acronym, state, tip }: IndicatorProps): React.JSX.Element {
  return (
    <li>
      <span className="chip" data-state={state} role="img" aria-label={tip} title={tip}>
        {acronym}
      </span>
    </li>
  );
}

/**
 * The header takes the active language and theme and a way to change each, and the health answer the page reads once
 * (`null` until it has arrived, with `unreachable` set while the server does not answer). The language and the theme live in
 * `App`, which owns the page.
 */
type HeaderProps = {
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  health: Health | null;
  unreachable: boolean;
};

/**
 * Top bar of the page: the title, the row of state indicators and the theme and language buttons (FR-057, FR-065). The
 * indicators are DB, LLM, PRS, the sandbox runtime and TODO with the count of the named simplifications, which is also the
 * button that opens their list (FR-066); an API indicator comes first while the server does not answer. They and the two
 * buttons are of one fixed size. Each theme or language button is one button that switches to the other value of its closed
 * list and shows that other value, a sun or a moon for the theme and a language code for the language; its name says the
 * action in the active language, and every box of the row carries a tooltip of what it is.
 */
export function Header({ lang, onLangChange, theme, onThemeChange, health, unreachable }: HeaderProps): React.JSX.Element {
  const toLang = nextLang(lang);
  const toTheme = nextTheme(theme);
  const todoTip = health === null ? '' : translate(lang, 'chip.todo', { count: health.todo.length });

  return (
    <header className="header">
      <h1>{translate(lang, 'app.title')}</h1>
      <ul className="health" aria-label={translate(lang, 'header.health')}>
        {unreachable ? <Indicator acronym="API" state="down" tip={translate(lang, 'chip.api.down')} /> : null}
        {health === null ? null : (
          <>
            <Indicator acronym="DB" state={health.db} tip={translateName(lang, 'chip.db', health.db)} />
            <Indicator acronym="LLM" state={health.model} tip={translateName(lang, 'chip.model', health.model)} />
            <Indicator acronym="PRS" state={health.parser} tip={translateName(lang, 'chip.parser', health.parser)} />
            <Indicator acronym={health.sandbox.toUpperCase()} state="info" tip={translate(lang, 'chip.runtime', { runtime: health.sandbox })} />
            <li>
              <button type="button" className="chip" data-state={health.todo.length > 0 ? 'warn' : 'ok'} aria-label={todoTip} title={todoTip} onClick={() => navigate({ view: 'simplifications' })}>
                {`TODO ${health.todo.length}`}
              </button>
            </li>
          </>
        )}
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
    </header>
  );
}
