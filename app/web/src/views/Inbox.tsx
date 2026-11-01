import React from 'react';
import { pageAfterResize, pageWindow } from '../../../src/shared/pager.ts';
import { ApiError, apiFetch, apiJson, poll } from '../api.ts';
import { Pager } from '../components/Pager.tsx';
import type { PagerControls } from '../components/Pager.tsx';
import { errorText } from '../errors.ts';
import { timeText } from '../labels.ts';
import { parseInbox, parseReadResult, parseUploadResult } from '../model.ts';
import type { InboxFile, InboxListing, ReadResult, UploadResult } from '../model.ts';
import { translate, translateName } from '../t.ts';
import type { Lang } from '../t.ts';

/** What the folder view takes: the page's language, the way to open a document in the detail view, and the pages of the list. */
type InboxProps = {
  lang: Lang;
  onOpen: (number: number) => void;
  /** The pages of the file list, or null until the page sizes have arrived. */
  pager: PagerControls | null;
};

/** A button that opens a document by its number; it is a button, not a link, because the views are state and not routes. */
function OpenButton({ number, lang, onOpen }: { number: number; lang: Lang; onOpen: (number: number) => void }): React.JSX.Element {
  return (
    <button type="button" className="link" onClick={() => onOpen(number)}>
      {translate(lang, 'common.documentNumber', { number })}
    </button>
  );
}

/** The rows of the page shown: the server sends the whole folder and the whole result, so the page is cut here, from the window of the pager. */
function rowsOfPage<Row>(rows: Row[], pager: PagerControls): Row[] {
  const { offset } = pageWindow(rows.length, pager.size, pager.page);
  return rows.slice(offset, offset + pager.size);
}

/** One line of the result of a read: a file that became a document, one that was already known, or one that was skipped. */
type ResultEntry =
  | { kind: 'taken'; number: number; name: string; documentClass: string }
  | { kind: 'duplicate'; name: string; originalNumber: number }
  | { kind: 'skipped'; name: string; reason: string };

/** The result of a read as one list, in the order the owner reads it: taken, then duplicates, then skipped. */
function entriesOf(result: ReadResult): ResultEntry[] {
  return [
    ...result.taken.map((item): ResultEntry => ({ kind: 'taken', ...item })),
    ...result.duplicates.map((item): ResultEntry => ({ kind: 'duplicate', ...item })),
    ...result.skipped.map((item): ResultEntry => ({ kind: 'skipped', ...item })),
  ];
}

/**
 * The folder view (FR-001, FR-005, FR-053): the files of the inbox as the server lists them, refreshed every two seconds
 * without hashing anything, and the "Read folder" action that takes them in. The result of a read is shown as it came:
 * which files became documents, which were already known and under which number, which were skipped and why. File names
 * are the owner's own text and are shown as text only (FR-055). The result can be hidden with its own button and brought
 * back with another beside "Read folder", and a new read shows it again; a long result is shown in pages in the same
 * size as the other lists. The pager of every list stands below the list. Beside it, one file can be uploaded from the browser
 * (FR-004): the answer is either the number of the new document or the number of the document that already has these bytes.
 * The native file input is hidden and a button of the page opens it, so the texts of the chooser ("choose", "no file chosen") come
 * from the dictionary and follow the language; the name of the file last chosen is shown as text beside the button.
 * The file list is shown in pages: the server sends the whole folder, so the page is cut here, and a page that no longer
 * exists (the folder shrank, or the size grew) is brought back to the last one that does.
 */
export function Inbox({ lang, onOpen, pager }: InboxProps): React.JSX.Element {
  const [listing, setListing] = React.useState<InboxListing | null>(null);
  const [listingFailed, setListingFailed] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [result, setResult] = React.useState<ReadResult | null>(null);
  const [resultHidden, setResultHidden] = React.useState(false);
  const [resultPage, setResultPage] = React.useState(1);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploaded, setUploaded] = React.useState<UploadResult | null>(null);
  const [uploadFailure, setUploadFailure] = React.useState<unknown>(null);
  const [chosenName, setChosenName] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const total = listing?.files.length;
  const size = pager?.size;
  const page = pager?.page;
  const onPage = pager?.onPage;
  React.useEffect(() => {
    if (total !== undefined && size !== undefined && page !== undefined && onPage !== undefined) {
      const inRange = pageWindow(total, size, page).page;
      if (inRange !== page) {
        onPage(inRange);
      }
    }
  }, [total, size, page, onPage]);

  const entries = result === null ? [] : entriesOf(result);
  const resultTotal = result === null ? undefined : entries.length;
  React.useEffect(() => {
    if (resultTotal !== undefined && size !== undefined) {
      const inRange = pageWindow(resultTotal, size, resultPage).page;
      if (inRange !== resultPage) {
        setResultPage(inRange);
      }
    }
  }, [resultTotal, size, resultPage]);

  /** The controls of the result's pager: the size is the one of the other lists, the page is the result's own. */
  const resultControls: PagerControls | null =
    pager === null
      ? null
      : {
          ...pager,
          page: resultPage,
          onPage: setResultPage,
          onSize: (newSize) => {
            setResultPage(pageAfterResize(resultPage, pager.size, newSize));
            pager.onSize(newSize);
          },
        };

  React.useEffect(
    () =>
      poll(
        'inbox',
        2000,
        parseInbox,
        (data) => {
          setListing(data);
          setListingFailed(false);
        },
        () => setListingFailed(true),
      ),
    [],
  );

  /** Takes the folder in and shows what came of it; a failed read leaves the previous result where it was. */
  async function readFolder(): Promise<void> {
    setReading(true);
    setFailure(null);
    try {
      setResult(parseReadResult(await apiJson('inbox/read', { method: 'POST' })));
      setResultHidden(false);
      setResultPage(1);
    } catch (error) {
      setFailure(error);
    } finally {
      setReading(false);
    }
  }

  /**
   * Sends the chosen file as the one multipart field the server expects. The input is emptied afterwards so that choosing
   * the same file again is a change the browser reports; the file's name goes to the server as a description only.
   */
  async function upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    setChosenName(file.name);
    setUploading(true);
    setUploaded(null);
    setUploadFailure(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      setUploaded(parseUploadResult(await (await apiFetch('documents', { method: 'POST', body: form })).json()));
    } catch (error) {
      setUploadFailure(error);
    } finally {
      input.value = '';
      setUploading(false);
    }
  }

  return (
    <section className="stack">
      <div className="toolbar">
        <button type="button" disabled={reading} onClick={() => void readFolder()}>
          {translate(lang, reading ? 'inbox.reading' : 'inbox.read')}
        </button>
        {result !== null && resultHidden ? (
          <button type="button" onClick={() => setResultHidden(false)}>
            {translate(lang, 'inbox.result.show')}
          </button>
        ) : null}
        {listing === null ? null : <span className="muted">{translate(lang, 'inbox.folder', { path: listing.path, count: listing.files.length })}</span>}
      </div>

      <div className="toolbar">
        <div className="upload">
          <span>{translate(lang, uploading ? 'upload.sending' : 'upload.label')}</span>
          <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {translate(lang, 'upload.choose')}
          </button>
          <span className="muted">{chosenName ?? translate(lang, 'upload.none')}</span>
          <input ref={fileInput} type="file" hidden onChange={(event) => void upload(event.currentTarget)} />
        </div>
        {uploaded === null ? null : (
          <span aria-live="polite">
            {uploaded.kind === 'new' ? translate(lang, 'upload.new') : translate(lang, 'upload.duplicate')}{' '}
            <OpenButton number={uploaded.kind === 'new' ? uploaded.number : uploaded.originalNumber} lang={lang} onOpen={onOpen} />
          </span>
        )}
        {uploadFailure === null ? null : (
          <span role="alert" className="notice">
            {uploadFailure instanceof ApiError && uploadFailure.status === 413 ? translate(lang, 'upload.tooLarge') : errorText(lang, uploadFailure)}
          </span>
        )}
      </div>

      {failure === null ? null : <p role="alert" className="notice">{errorText(lang, failure)}</p>}
      {listingFailed ? <p role="alert" className="notice">{translate(lang, 'inbox.listFailed')}</p> : null}

      {result === null || resultHidden ? null : (
        <div className="result" aria-live="polite">
          <div className="result-head">
            <h2>{translate(lang, 'inbox.result')}</h2>
            <button type="button" onClick={() => setResultHidden(true)}>
              {translate(lang, 'inbox.result.hide')}
            </button>
          </div>
          <p>{translate(lang, 'inbox.result.counts', { taken: result.taken.length, duplicates: result.duplicates.length, skipped: result.skipped.length })}</p>
          <ul>
            {(resultControls === null ? entries : rowsOfPage(entries, resultControls)).map((entry) =>
              entry.kind === 'taken' ? (
                <li key={`taken-${entry.number}`}>
                  <OpenButton number={entry.number} lang={lang} onOpen={onOpen} /> {translate(lang, 'inbox.result.taken', { name: entry.name, documentClass: translateName(lang, 'class', entry.documentClass) })}
                </li>
              ) : entry.kind === 'duplicate' ? (
                <li key={`duplicate-${entry.name}`}>
                  {translate(lang, 'inbox.result.duplicate', { name: entry.name })} <OpenButton number={entry.originalNumber} lang={lang} onOpen={onOpen} />
                </li>
              ) : (
                <li key={`skipped-${entry.name}`}>{translate(lang, 'inbox.result.skipped', { name: entry.name, reason: translateName(lang, 'skipped', entry.reason) })}</li>
              ),
            )}
          </ul>
          {resultControls === null || entries.length === 0 ? null : <Pager lang={lang} total={entries.length} controls={resultControls} />}
        </div>
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
                </tr>
              </thead>
              <tbody>
                {rowsOfPage(listing.files, pager).map((file) => (
                  <tr key={file.name}>
                    <td>{file.name}</td>
                    <td className="num">{file.sizeBytes.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB')}</td>
                    <td>{timeText(file.modifiedAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager lang={lang} total={listing.files.length} controls={pager} />
        </>
      )}
    </section>
  );
}
