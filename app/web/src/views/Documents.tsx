import React from 'react';
import { parseDocumentList } from '../api/answers.ts';
import type { Meta } from '../api/answers.ts';
import { usePolledAnswer } from '../api/usePolledAnswer.ts';
import { DocumentCard } from '../components/DocumentCard.tsx';
import { Pager } from '../components/Pager.tsx';
import { ReasonList } from '../components/ReasonList.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Window } from '../components/Window.tsx';
import { typeLabel } from '../i18n/display.ts';
import { errorText } from '../i18n/errors.ts';
import { translate, translateName } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';
import { useFitPage } from '../pager.ts';
import type { PagerControls } from '../pager.ts';
import { closeWindow, navigate } from '../router.ts';

/** What the table takes: the page's language, what it derives from the registry, the document whose window is open, and the pages of the table. */
type DocumentsProps = {
  lang: Lang;
  meta: Meta;
  /** The number of the document whose window is open, from the address, or null. */
  openNumber: number | null;
  /** The pages of the table, or null until the page sizes have arrived. */
  pager: PagerControls | null;
};

/**
 * The documents table (FR-053, FR-060, FR-063): under a short explanation of what a document is, the number, name, where it
 * came from (the folder or an upload), class, type, status and the reasons as messages in the active language, newest
 * first, refreshed every two seconds. A click on a number or a name opens the document's card in a window above the table.
 * The list the server sends carries codes and parameters and no text of the documents; every cell is set as text, so a file
 * name or a quoted fragment is never read as markup (FR-054, FR-055). A poll that fails keeps the last table on screen and
 * says so, because the next poll may well succeed. Only the rows of the page shown are fetched, with the page size as
 * `limit` and the page's first row as `offset`; a change of page or of size starts the poll again at once.
 */
export function Documents({ lang, meta, openNumber, pager }: DocumentsProps): React.JSX.Element {
  const path = pager === null ? null : `documents?limit=${pager.size}&offset=${(pager.page - 1) * pager.size}`;
  const { data: list, failure } = usePolledAnswer(path, parseDocumentList);
  useFitPage(pager, list?.count);

  return (
    <section className="stack">
      <p className="explain">{translate(lang, 'documents.explain')}</p>
      {failure === null ? null : <p role="alert" className="notice">{errorText(lang, failure)}</p>}
      {list === null || pager === null ? (
        <p className="muted">{translate(lang, 'common.loading')}</p>
      ) : list.count === 0 ? (
        <p className="muted">{translate(lang, 'documents.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">{translate(lang, 'documents.col.number')}</th>
                  <th>{translate(lang, 'documents.col.name')}</th>
                  <th>{translate(lang, 'documents.col.origin')}</th>
                  <th>{translate(lang, 'documents.col.class')}</th>
                  <th>{translate(lang, 'documents.col.type')}</th>
                  <th>{translate(lang, 'documents.col.status')}</th>
                  <th>{translate(lang, 'documents.col.reasons')}</th>
                </tr>
              </thead>
              <tbody>
                {list.documents.map((row) => (
                  <tr key={row.number}>
                    <td className="num">
                      <button type="button" className="link" onClick={() => navigate({ view: 'documents', number: row.number })}>
                        {row.number}
                      </button>
                    </td>
                    <td className="words">
                      <button type="button" className="link" onClick={() => navigate({ view: 'documents', number: row.number })}>
                        {row.originalName ?? ''}
                      </button>
                    </td>
                    <td className="nowrap">{translateName(lang, 'origin', row.origin)}</td>
                    <td className="nowrap">{translateName(lang, 'class', row.documentClass)}</td>
                    <td className="words">{row.type === null ? translate(lang, 'common.none') : typeLabel(meta, row.type, lang)}</td>
                    <td>
                      <StatusBadge status={row.status} lang={lang} />
                    </td>
                    <td>
                      <ReasonList meta={meta} reasons={row.reasons} typeName={row.type} lang={lang} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager lang={lang} total={list.count} controls={pager} />
        </>
      )}
      {openNumber === null ? null : (
        <Window lang={lang} label={translate(lang, 'common.documentNumber', { number: openNumber })} onClose={closeWindow}>
          <DocumentCard key={openNumber} lang={lang} meta={meta} number={openNumber} />
        </Window>
      )}
    </section>
  );
}
