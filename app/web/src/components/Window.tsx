import React from 'react';
import { translate } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the window takes: the page's language, the name it carries for assistive technology, how to close it, and its content. */
type WindowProps = {
  lang: Lang;
  /** The accessible name of the window; the visible heading is the content's own. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A modal window above the page (FR-060), made of the browser's own `<dialog>` opened with `showModal`: the browser keeps
 * the focus inside it, dims the page behind it and answers Esc with a `cancel` event, which is turned into the page's own
 * way of closing so the address goes back to the list; no library and no key handler are needed. The window opens when it
 * is mounted and closes when it is unmounted, so a route that has a window mounts one and a route that has none does not.
 */
export function Window({ lang, label, onClose, children }: WindowProps): React.JSX.Element {
  const dialog = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) {
      element.showModal();
    }
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="window"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="window-head">
        <button type="button" onClick={onClose}>
          {translate(lang, 'window.close')}
        </button>
      </div>
      <div className="window-body">{children}</div>
    </dialog>
  );
}
