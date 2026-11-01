import React from 'react';
import { pageItems, pageWindow } from '../../../src/shared/pager.ts';
import { translate } from '../t.ts';
import type { Lang } from '../t.ts';

/** What a view needs to show and drive its pages: the choices, the size and page now, and the two ways to change them. */
export type PagerControls = {
  /** The page sizes the owner can choose from, and the one in force. */
  sizes: number[];
  size: number;
  /** The page shown, counted from 1. */
  page: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
};

/** What the pager takes: the page's language, how many rows the list has in all, and the controls of the view. */
type PagerProps = {
  lang: Lang;
  total: number;
  controls: PagerControls;
};

/**
 * The navigation of a list shown in pages (FR-053), which stands below the list it pages and never above it: "Previous", the numbers of the pages with the first and the last always
 * among them, "Next", the range of rows, and the choice of the page size, all in one line. "Previous" and "Next" are always
 * there and are disabled where they cannot act, and the row of numbers keeps the same number of slots wherever the current
 * page is, so the layout never moves and nothing vanishes under the pointer. What is enabled follows from `pageWindow` and
 * `pageItems` alone, the arithmetic the tests table. The page number is brought into range here for display, and the view
 * corrects its own state when it sees it was out of range. The arrows and the ellipsis are written as escapes, so the source
 * stays ASCII.
 */
export function Pager({ lang, total, controls }: PagerProps): React.JSX.Element {
  const window = pageWindow(total, controls.size, controls.page);
  return (
    <nav className="pager" aria-label={translate(lang, 'pager.label')}>
      <div className="pager-pages">
        <button type="button" className="pager-step" disabled={!window.hasPrevious} onClick={() => controls.onPage(window.page - 1)}>
          <span aria-hidden="true">{'\u2039'}</span> {translate(lang, 'pager.previous')}
        </button>
        {pageItems(window.pages, window.page).map((item) =>
          typeof item === 'number' ? (
            <button
              key={item}
              type="button"
              className="pager-number"
              aria-current={item === window.page ? 'page' : undefined}
              aria-label={translate(lang, 'pager.page', { page: item })}
              onClick={() => controls.onPage(item)}
            >
              {item}
            </button>
          ) : (
            <span key={item} className="pager-gap" aria-hidden="true">
              {'\u2026'}
            </span>
          ),
        )}
        <button type="button" className="pager-step" disabled={!window.hasNext} onClick={() => controls.onPage(window.page + 1)}>
          {translate(lang, 'pager.next')} <span aria-hidden="true">{'\u203A'}</span>
        </button>
      </div>
      <span className="muted">{translate(lang, 'pager.range', { first: window.first, last: window.last, total })}</span>
      <label className="pager-size">
        <span>{translate(lang, 'pager.size')}</span>
        <select value={controls.size} onChange={(event) => controls.onSize(Number(event.currentTarget.value))}>
          {controls.sizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}
