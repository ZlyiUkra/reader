import React from 'react';
import type { InboxFile } from '../api/answers.ts';
import { translate, translateName } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the note takes: the page's language, the file name from the address, and the folder's row for it once the list has arrived. */
type FileNoteProps = {
  lang: Lang;
  name: string;
  /** The row of the folder list with this name; undefined while the list is loading, null when the folder has no such file. */
  file: InboxFile | null | undefined;
};

/**
 * What the window of a folder file says when the file is not a document (FR-060): that it cannot be viewed, and why. The
 * system opens the bytes of a file only in the sandbox and only when the file is read, so a file that has not been read has
 * nothing to show; a file that was skipped says why it was skipped. The file name is the owner's own text and is set as text.
 */
export function FileNote({ lang, name, file }: FileNoteProps): React.JSX.Element {
  return (
    <section className="stack">
      <h2 className="words">{name}</h2>
      {file === undefined ? (
        <p className="muted">{translate(lang, 'common.loading')}</p>
      ) : file === null ? (
        <p role="alert" className="notice">{translate(lang, 'file.missing')}</p>
      ) : (
        <>
          <dl className="facts">
            <dt>{translate(lang, 'inbox.col.size')}</dt>
            <dd>{file.sizeBytes.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB')}</dd>
            <dt>{translate(lang, 'inbox.col.modified')}</dt>
            <dd>{new Date(file.modifiedAt).toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB')}</dd>
          </dl>
          <p>{file.state.kind === 'skipped' ? translateName(lang, 'file.cannotView', file.state.reason) : translate(lang, 'file.cannotView.unread')}</p>
        </>
      )}
    </section>
  );
}
