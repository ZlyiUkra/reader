import React from 'react';
import { parseMeta } from './api/answers.ts';
import { usePolledAnswer } from './api/usePolledAnswer.ts';
import { Header } from './components/Header.tsx';
import { NewVersion } from './components/NewVersion.tsx';
import { readLang, storeLang, translate } from './i18n/t.ts';
import type { Lang, TextKey } from './i18n/t.ts';
import { usePagers } from './pager.ts';
import { navigate, useRoute } from './router.ts';
import { applyTheme, readTheme, storeTheme } from './theme.ts';
import type { Theme } from './theme.ts';
import { Documents } from './views/Documents.tsx';
import { Inbox } from './views/Inbox.tsx';
import { Types } from './views/Types.tsx';

/**
 * The three views of the page (FR-053) as a closed list, each with an address (FR-060). The document card is not one of
 * them: it opens in a window above the folder list or the documents table, and the route says which.
 */
const views = ['folder', 'documents', 'types'] as const;
type View = (typeof views)[number];

/** Dictionary key of the navigation label of each view. */
const viewTexts: Record<View, TextKey> = {
  folder: 'nav.folder',
  documents: 'nav.documents',
  types: 'nav.types',
};

/**
 * Shell of the page: the header with the language and theme switches, the navigation of the three views and the panel of
 * the active view. The language and the theme are read once from the browser's memory, applied to the document and changed
 * through their switches, which also remember the choice; the view and the open window come from the route, the address in
 * the page's URL (`router.ts`). The registry's labels and the reasons' templates are fetched once (`GET /api/meta`) and handed
 * to the views that show them; until they have arrived the views say they are loading, and a failed fetch is tried again,
 * because the server may simply not be up yet. The paging of both lists lives here (`pager.ts`), because the views come and
 * go as the owner moves between them and the lists keep their place. A notice appears when the server starts serving a newer
 * build of the page.
 */
export function App(): React.JSX.Element {
  const [lang, setLang] = React.useState(readLang);
  const [theme, setTheme] = React.useState(readTheme);
  const route = useRoute();
  const { data: meta } = usePolledAnswer('meta', parseMeta, { once: true });
  const pagers = usePagers(meta);

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

  /** Goes to the list of a view, without any window open. */
  function openView(view: View): void {
    navigate(view === 'folder' ? { view, file: null } : view === 'documents' ? { view, number: null } : { view });
  }

  return (
    <div className="page">
      <Header lang={lang} onLangChange={changeLang} theme={theme} onThemeChange={changeTheme} />
      <NewVersion lang={lang} />
      <nav className="tabs" aria-label={translate(lang, 'nav.label')}>
        {views.map((name) => (
          <button key={name} type="button" aria-pressed={route.view === name} onClick={() => openView(name)}>
            {translate(lang, viewTexts[name])}
          </button>
        ))}
      </nav>
      <main className="panel">
        {route.view === 'folder' ? <Inbox lang={lang} meta={meta} openFile={route.file} pager={pagers.folder} /> : null}
        {route.view === 'documents' ? (
          meta === null ? (
            <p className="muted">{translate(lang, 'common.loading')}</p>
          ) : (
            <Documents lang={lang} meta={meta} openNumber={route.number} pager={pagers.documents} />
          )
        ) : null}
        {route.view === 'types' ? <Types lang={lang} meta={meta} /> : null}
      </main>
    </div>
  );
}
