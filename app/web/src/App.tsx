import React from 'react';
import { poll } from './api.ts';
import { Header } from './components/Header.tsx';
import { parseMeta } from './model.ts';
import type { Meta } from './model.ts';
import { readLang, storeLang, translate } from './t.ts';
import type { Lang, TextKey } from './t.ts';
import { applyTheme, readTheme, storeTheme } from './theme.ts';
import type { Theme } from './theme.ts';
import { Document } from './views/Document.tsx';
import { Documents } from './views/Documents.tsx';
import { Inbox } from './views/Inbox.tsx';

/**
 * The three views of the page (FR-053, C15) as a closed list. They are component state and not routes: the owner
 * rarely uses routers and the three views are served without one (AGENTS.md, Front).
 */
const views = ['folder', 'documents', 'detail'] as const;
type View = (typeof views)[number];

/** Dictionary key of the navigation label of each view. */
const viewTexts: Record<View, TextKey> = {
  folder: 'nav.folder',
  documents: 'nav.documents',
  detail: 'nav.detail',
};

/**
 * Shell of the page: the header with the language and theme switches, the navigation of the three views and the panel
 * of the active view. The language and the theme are read once from the browser's memory, applied to the document and
 * changed through their switches, which also remember the choice; the view is state, and so is the number of the document
 * the detail view shows, which the other two views set when the owner opens a document. The registry's labels and the
 * reasons' templates are fetched once (`GET /api/meta`) and handed to the views that show them; until they have arrived
 * the page says it is loading, and a failed fetch is tried again, because the server may simply not be up yet.
 */
export function App(): React.JSX.Element {
  const [lang, setLang] = React.useState(readLang);
  const [theme, setTheme] = React.useState(readTheme);
  const [view, setView] = React.useState<View>('folder');
  const [opened, setOpened] = React.useState<number | null>(null);
  const [meta, setMeta] = React.useState<Meta | null>(null);

  React.useEffect(() => {
    let stop: () => void = () => undefined;
    stop = poll('meta', 2000, parseMeta, (data) => {
      setMeta(data);
      stop();
    }, () => undefined);
    return () => stop();
  }, []);

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

  /** Opens a document in the detail view: the other views call this when the owner picks a number. */
  function openDocument(number: number): void {
    setOpened(number);
    setView('detail');
  }

  return (
    <div className="page">
      <Header lang={lang} onLangChange={changeLang} theme={theme} onThemeChange={changeTheme} />
      <nav className="tabs" aria-label={translate(lang, 'nav.label')}>
        {views.map((name) => (
          <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>
            {translate(lang, viewTexts[name])}
          </button>
        ))}
      </nav>
      <main className="panel">
        {view === 'folder' ? <Inbox lang={lang} onOpen={openDocument} /> : null}
        {meta === null ? (
          view === 'folder' ? null : <p className="muted">{translate(lang, 'common.loading')}</p>
        ) : view === 'documents' ? (
          <Documents lang={lang} meta={meta} onOpen={openDocument} />
        ) : view === 'detail' ? (
          <Document lang={lang} meta={meta} number={opened} />
        ) : null}
      </main>
    </div>
  );
}
