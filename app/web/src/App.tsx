import React from 'react';
import { readLang, translate } from './t.ts';
import type { TextKey } from './t.ts';

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
 * Skeleton of the page: the language is read once and applied to the document, the view is state, and each view is a
 * placeholder until its own task writes it (`views/Inbox.tsx`, `Documents.tsx`, `Document.tsx`). The language switch
 * and the header with the health data arrive with `components/Header.tsx`.
 */
export function App(): React.JSX.Element {
  const [lang] = React.useState(readLang);
  const [view, setView] = React.useState<View>('folder');

  React.useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <main>
      <h1>{translate(lang, 'app.title')}</h1>
      <nav>
        {views.map((name) => (
          <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>
            {translate(lang, viewTexts[name].nav)}
          </button>
        ))}
      </nav>
      <section>
        <p>{translate(lang, viewTexts[view].placeholder)}</p>
      </section>
    </main>
  );
}
