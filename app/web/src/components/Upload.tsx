import React from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { parseUploadResult } from '../api/answers.ts';
import type { UploadResult } from '../api/answers.ts';
import { errorText } from '../i18n/errors.ts';
import { translate } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the upload control takes: the page's language and the way to open the document an upload made or found. */
type UploadProps = {
  lang: Lang;
  onOpen: (number: number) => void;
};

/**
 * One file uploaded from the browser (FR-004): the answer is either the number of the new document or the number of the
 * document that already has these bytes. The native file input is hidden and a button of the page opens it, so the texts of
 * the chooser ("choose", "no file chosen") come from the dictionary and follow the language; the name of the file last
 * chosen is shown as text beside the button. The input is emptied afterwards so that choosing the same file again is a change
 * the browser reports; the file's name goes to the server as a description only.
 */
export function Upload({ lang, onOpen }: UploadProps): React.JSX.Element {
  const [uploading, setUploading] = React.useState(false);
  const [uploaded, setUploaded] = React.useState<UploadResult | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [chosenName, setChosenName] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  /** Sends the chosen file as the one multipart field the server expects. */
  async function upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    setChosenName(file.name);
    setUploading(true);
    setUploaded(null);
    setFailure(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      setUploaded(parseUploadResult(await (await apiFetch('documents', { method: 'POST', body: form })).json()));
    } catch (error) {
      setFailure(error);
    } finally {
      input.value = '';
      setUploading(false);
    }
  }

  return (
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
          <button type="button" className="link" onClick={() => onOpen(uploaded.kind === 'new' ? uploaded.number : uploaded.originalNumber)}>
            {translate(lang, 'common.documentNumber', { number: uploaded.kind === 'new' ? uploaded.number : uploaded.originalNumber })}
          </button>
        </span>
      )}
      {failure === null ? null : (
        <span role="alert" className="notice">
          {failure instanceof ApiError && failure.status === 413 ? translate(lang, 'upload.tooLarge') : errorText(lang, failure)}
        </span>
      )}
    </div>
  );
}
