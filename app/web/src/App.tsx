import React from 'react';
import { Header } from './components/Header.tsx';
import { readLang, storeLang, translate } from './t.ts';
import type { Lang, TextKey } from './t.ts';
import { applyTheme, readTheme, storeTheme } from './theme.ts';
import type { Theme } from './theme.ts';

/**
 * The three views of the page (FR-053, C15) as a closed list. They are component state and not routes: the owner
 * rarely uses routers and the three views are served without one (AGENTS.md, Front).
 */
const views = ['folder', 'documents', 'detail'] as const;
type View = (typeof views)[number];

/** Dictionary keys of the navigation label and of the placeholder text of each view. */
const viewTexts: Record<View, { nav: TextKey; placeholder: TextKey }> = {
  folder: { nav: 'nav.folder', placeholder: 'view.folder.placeholder' },
  documents: { nav: 'nav.documents', placeholder: 'view.documents.placeholder' },
  detail: { nav: 'nav.detail', placeholder: 'view.detail.placeholder' },
};

/**
 * Shell of the page: the header with the language and theme switches, the navigation of the three views and the panel
 * of the active view. The language and the theme are read once from the browser's memory, applied to the document and
 * changed through their switches, which also remember the choice; the view is state, and each view is a placeholder
 * until its own task writes it (`views/Inbox.tsx`, `Documents.tsx`, `Document.tsx`).
 */
export function App(): React.JSX.Element {
  const [lang, setLang] = React.useState(readLang);
  const [theme, setTheme] = React.useState(readTheme);
  const [view, setView] = React.useState<View>('folder');

  React.useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // A layout effect, so a remembered light theme is on the root before the first paint and the page does not flash dark.
  React.useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /** Applies a language chosen on the switch and remembers it for the next visit. */
  function changeLang(next: Lang): void {
    setLang(next);
    storeLang(next);
  }

  /** Applies a theme chosen on the switch and remembers it for the next visit. */
  function changeTheme(next: Theme): void {
    setTheme(next);
    storeTheme(next);
  }

  return (
    <div className="page">
      <Header lang={lang} onLangChange={changeLang} theme={theme} onThemeChange={changeTheme} />
      <nav className="tabs" aria-label={translate(lang, 'nav.label')}>
        {views.map((name) => (
          <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>
            {translate(lang, viewTexts[name].nav)}
          </button>
        ))}
      </nav>
      <main className="panel">
        <p>{translate(lang, viewTexts[view].placeholder)}</p>
      </main>
    </div>
  );
}
