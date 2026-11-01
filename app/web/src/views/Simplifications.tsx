import React from 'react';
import type { Health } from '../api/answers.ts';
import { translate } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the simplifications view takes: the page's language and the health answer the page reads once, null while it loads. */
type SimplificationsProps = {
  lang: Lang;
  health: Health | null;
};

/**
 * The named simplifications of the prototype (FR-052, FR-066): each with its text and what ends it, in the page language,
 * exactly as `GET /api/health` reports them, so the count in the header and the rows here are the same list. A short
 * explanation says what a named simplification is. Every cell is text.
 */
export function Simplifications({ lang, health }: SimplificationsProps): React.JSX.Element {
  if (health === null) {
    return <p className="muted">{translate(lang, 'common.loading')}</p>;
  }
  return (
    <section className="stack">
      <p className="explain">{translate(lang, 'simplifications.explain')}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{translate(lang, 'simplifications.col.what')}</th>
              <th>{translate(lang, 'simplifications.col.ends')}</th>
            </tr>
          </thead>
          <tbody>
            {health.todo.map((item) => (
              <tr key={item.id}>
                <td className="words">{item[lang]}</td>
                <td className="words">{item.trigger[lang]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
