import React from 'react';
import { parseInbox, parseReadResult } from '../api/answers.ts';
import type { InboxState, Meta, ReadResult } from '../api/answers.ts';
import { apiJson } from '../api/client.ts';
import { usePolledAnswer } from '../api/usePolledAnswer.ts';
import { DocumentCard } from '../components/DocumentCard.tsx';
import { FileNote } from '../components/FileNote.tsx';
import { Pager } from '../components/Pager.tsx';
import { Upload } from '../components/Upload.tsx';
import { Window } from '../components/Window.tsx';
import { timeText } from '../i18n/display.ts';
import { errorText } from '../i18n/errors.ts';
import { translate, translateName } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';
import { rowsOfPage, useFitPage } from '../pager.ts';
import type { PagerControls } from '../pager.ts';
import { closeWindow, navigate } from '../router.ts';

/** What the folder view takes: the page's language, what it derives from the registry (null while it loads), the file whose window is open, and the pages of the list. */
type InboxProps = {
  lang: Lang;
  meta: Meta | null;
  /** The name of the folder file whose window is open, from the address, or null. */
  openFile: string | null;
  /** The pages of the file list, or null until the page sizes have arrived. */
  pager: PagerControls | null;
};

/** What a row says the file is to the system, in the active language (FR-061). */
function stateText(lang: Lang, state: InboxState): string {
  if (state.kind === 'document') {
    return translate(lang, 'inbox.state.document', { number: state.number });
  }
  if (state.kind === 'skipped') {
    return translate(lang, 'inbox.state.skipped', { reason: translateName(lang, 'skipped', state.reason) });
  }
  return translate(lang, 'inbox.state.unread');
}

/**
 * The folder view (FR-001, FR-005, FR-053, FR-060, FR-061, FR-063): the files of the inbox as the server lists them,
 * refreshed every two seconds, each with what it is to the system (not read yet, a document, skipped and why), under a
 * short explanation of what the folder is. "Read folder" takes the new files in and the states of the rows change by
 * themselves; one line says how many files were taken, found to be duplicates and skipped, and there is no second list of
 * the same files. A click on a file opens its window above the list: the card of its document, or, for a file that is not a
 * document, a note that says why it cannot be viewed. File names are the owner's own text and are shown as text only
 * (FR-055). The pager stands below the list; a page that no longer exists is brought back to the last one that does.
 */
export function Inbox({ lang, meta, openFile, pager }: InboxProps): React.JSX.Element {
  const { data: listing, failure: listingFailure } = usePolledAnswer('inbox', parseInbox);
  const [reading, setReading] = React.useState(false);
  const [counts, setCounts] = React.useState<ReadResult | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);
  useFitPage(pager, listing?.files.length);

  /** Takes the folder in; a failed read leaves the previous line where it was. */
  async function readFolder(): Promise<void> {
    setReading(true);
    setFailure(null);
    try {
      setCounts(parseReadResult(await apiJson('inbox/read', { method: 'POST' })));
    } catch (error) {
      setFailure(error);
    } finally {
      setReading(false);
    }
  }

  const opened = openFile === null || listing === null ? undefined : (listing.files.find((file) => file.name === openFile) ?? null);

  return (
    <section className="stack">
      <p className="explain">{translate(lang, 'inbox.explain')}</p>
      <div className="toolbar">
        <button type="button" disabled={reading} onClick={() => void readFolder()}>
          {translate(lang, reading ? 'inbox.reading' : 'inbox.read')}
        </button>
        {listing === null ? null : <span className="muted">{translate(lang, 'inbox.folder', { path: listing.path, count: listing.files.length })}</span>}
      </div>

      <Upload lang={lang} onOpen={(number) => navigate({ view: 'documents', number })} />

      {failure === null ? null : <p role="alert" className="notice">{errorText(lang, failure)}</p>}
      {listingFailure === null ? null : <p role="alert" className="notice">{translate(lang, 'inbox.listFailed')}</p>}
      {counts === null ? null : (
        <p aria-live="polite">{translate(lang, 'inbox.result.counts', { taken: counts.taken.length, duplicates: counts.duplicates.length, skipped: counts.skipped.length })}</p>
      )}

      {listing === null || pager === null ? (
        <p className="muted">{translate(lang, 'common.loading')}</p>
      ) : listing.files.length === 0 ? (
        <p className="muted">{translate(lang, 'inbox.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{translate(lang, 'inbox.col.name')}</th>
                  <th className="num">{translate(lang, 'inbox.col.size')}</th>
                  <th>{translate(lang, 'inbox.col.modified')}</th>
                  <th>{translate(lang, 'inbox.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {rowsOfPage(listing.files, pager).map((file) => (
                  <tr key={file.name}>
                    <td className="words">
                      <button type="button" className="link" onClick={() => navigate({ view: 'folder', file: file.name })}>
                        {file.name}
                      </button>
                    </td>
                    <td className="num">{file.sizeBytes.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB')}</td>
                    <td>{timeText(file.modifiedAt, lang)}</td>
                    <td data-state={file.state.kind}>{stateText(lang, file.state)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager lang={lang} total={listing.files.length} controls={pager} />
        </>
      )}

      {openFile === null ? null : (
        <Window lang={lang} label={openFile} onClose={closeWindow}>
          {opened?.state.kind === 'document' ? (
            meta === null ? (
              <p className="muted">{translate(lang, 'common.loading')}</p>
            ) : (
              <DocumentCard key={opened.state.number} lang={lang} meta={meta} number={opened.state.number} />
            )
          ) : (
            <FileNote lang={lang} name={openFile} file={opened} />
          )}
        </Window>
      )}
    </section>
  );
}
