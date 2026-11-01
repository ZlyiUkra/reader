import React from 'react';
import { pageWindow } from '../../../src/shared/pager.ts';
import { poll } from '../api.ts';
import { Pager } from '../components/Pager.tsx';
import type { PagerControls } from '../components/Pager.tsx';
import { ReasonList } from '../components/ReasonList.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { errorText } from '../errors.ts';
import { typeLabel } from '../labels.ts';
import { parseDocumentList } from '../model.ts';
import type { DocumentList, Meta } from '../model.ts';
import { translate, translateName } from '../t.ts';
import type { Lang } from '../t.ts';

/** What the table takes: the page's language, what it derives from the registry, the way to open a document and its pages. */
type DocumentsProps = {
  lang: Lang;
  meta: Meta;
  onOpen: (number: number) => void;
  /** The pages of the table, or null until the page sizes have arrived. */
  pager: PagerControls | null;
};

/**
 * The documents table (FR-053): number, name, class, type, status and the reasons as messages in the active language,
 * newest first, refreshed every two seconds. The list the server sends carries codes and parameters and no text of the
 * documents; every cell is set as text, so a file name or a quoted fragment is never read as markup (FR-054, FR-055). A
 * poll that fails keeps the last table on screen and says so, because the next poll may well succeed. Only the rows of the
 * page shown are fetched, with the page size as `limit` and the page's first row as `offset`; a change of page or of size
 * starts the poll again at once. A page that no longer exists (the size grew) is brought back to the last one that does.
 */
export function Documents({ lang, meta, onOpen, pager }: DocumentsProps): React.JSX.Element {
  const [list, setList] = React.useState<DocumentList | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);
  const size = pager?.size;
  const page = pager?.page;
  const onPage = pager?.onPage;

  React.useEffect(() => {
    if (size === undefined || page === undefined) {
      return undefined;
    }
    return poll(
      `documents?limit=${size}&offset=${(page - 1) * size}`,
      2000,
      parseDocumentList,
      (data) => {
        setList(data);
        setFailure(null);
      },
      setFailure,
    );
  }, [size, page]);

  React.useEffect(() => {
    if (list !== null && size !== undefined && page !== undefined && onPage !== undefined) {
      const inRange = pageWindow(list.count, size, page).page;
      if (inRange !== page) {
        onPage(inRange);
      }
    }
  }, [list, size, page, onPage]);

  return (
    <section className="stack">
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
                      <button type="button" className="link" onClick={() => onOpen(row.number)}>
                        {row.number}
                      </button>
                    </td>
                    <td>{row.originalName ?? ''}</td>
                    <td className="nowrap">{translateName(lang, 'class', row.documentClass)}</td>
                    <td>{row.type === null ? translate(lang, 'common.none') : typeLabel(meta, row.type, lang)}</td>
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
    </section>
  );
}
