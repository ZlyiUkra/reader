import React from 'react';
import { ApiError, apiFetch, apiJson, poll } from '../api.ts';
import { errorText } from '../errors.ts';
import { timeText } from '../labels.ts';
import { parseInbox, parseReadResult, parseUploadResult } from '../model.ts';
import type { InboxListing, ReadResult, UploadResult } from '../model.ts';
import { translate, translateName } from '../t.ts';
import type { Lang } from '../t.ts';

/** What the folder view takes: the page's language and the way to open a document in the detail view. */
type InboxProps = {
  lang: Lang;
  onOpen: (number: number) => void;
};

/** A button that opens a document by its number; it is a button, not a link, because the views are state and not routes. */
function OpenButton({ number, lang, onOpen }: { number: number; lang: Lang; onOpen: (number: number) => void }): React.JSX.Element {
  return (
    <button type="button" className="link" onClick={() => onOpen(number)}>
      {translate(lang, 'common.documentNumber', { number })}
    </button>
  );
}

/**
 * The folder view (FR-001, FR-005, FR-053): the files of the inbox as the server lists them, refreshed every two seconds
 * without hashing anything, and the "Read folder" action that takes them in. The result of a read is shown as it came:
 * which files became documents, which were already known and under which number, which were skipped and why. File names
 * are the owner's own text and are shown as text only (FR-055). Beside it, one file can be uploaded from the browser
 * (FR-004): the answer is either the number of the new document or the number of the document that already has these bytes.
 */
export function Inbox({ lang, onOpen }: InboxProps): React.JSX.Element {
  const [listing, setListing] = React.useState<InboxListing | null>(null);
  const [listingFailed, setListingFailed] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [result, setResult] = React.useState<ReadResult | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploaded, setUploaded] = React.useState<UploadResult | null>(null);
  const [uploadFailure, setUploadFailure] = React.useState<unknown>(null);

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
        {listing === null ? null : <span className="muted">{translate(lang, 'inbox.folder', { path: listing.path, count: listing.files.length })}</span>}
      </div>

      <div className="toolbar">
        <label className="upload">
          <span>{translate(lang, uploading ? 'upload.sending' : 'upload.label')}</span>
          <input type="file" disabled={uploading} onChange={(event) => void upload(event.currentTarget)} />
        </label>
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

      {result === null ? null : (
        <div className="result" aria-live="polite">
          <h2>{translate(lang, 'inbox.result')}</h2>
          <p>{translate(lang, 'inbox.result.counts', { taken: result.taken.length, duplicates: result.duplicates.length, skipped: result.skipped.length })}</p>
          <ul>
            {result.taken.map((item) => (
              <li key={`taken-${item.number}`}>
                <OpenButton number={item.number} lang={lang} onOpen={onOpen} /> {translate(lang, 'inbox.result.taken', { name: item.name, documentClass: translateName(lang, 'class', item.documentClass) })}
              </li>
            ))}
            {result.duplicates.map((item) => (
              <li key={`duplicate-${item.name}`}>
                {translate(lang, 'inbox.result.duplicate', { name: item.name })} <OpenButton number={item.originalNumber} lang={lang} onOpen={onOpen} />
              </li>
            ))}
            {result.skipped.map((item) => (
              <li key={`skipped-${item.name}`}>{translate(lang, 'inbox.result.skipped', { name: item.name, reason: translateName(lang, 'skipped', item.reason) })}</li>
            ))}
          </ul>
        </div>
      )}

      {listing === null ? (
        <p className="muted">{translate(lang, 'common.loading')}</p>
      ) : listing.files.length === 0 ? (
        <p className="muted">{translate(lang, 'inbox.empty')}</p>
      ) : (
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
              {listing.files.map((file) => (
                <tr key={file.name}>
                  <td>{file.name}</td>
                  <td className="num">{file.sizeBytes.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB')}</td>
                  <td>{timeText(file.modifiedAt, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
