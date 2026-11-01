/**
 * The arithmetic of a list shown in pages (FR-053), kept apart from the page so it can be tested as a table and so the
 * server's `offset` and the browser's page number are the same thing seen from two sides. Pages are numbered from 1.
 */

/** Where a page lies in a list, and which way it can move. */
export type PageWindow = {
  /** The page shown, after being brought into range. */
  page: number;
  /** How many pages the list has; an empty list has one. */
  pages: number;
  /** The row the page starts at, counted from 0: what the server takes as `offset`. */
  offset: number;
  /** The number of the first and the last row on the page, counted from 1; both 0 for an empty list. */
  first: number;
  last: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

/**
 * The window of `page` over `total` rows with `size` rows to a page. A page outside the list (the list shrank, or the owner
 * typed one) is brought to the nearest page that exists, so the page never shows nothing while rows exist.
 */
export function pageWindow(total: number, size: number, page: number): PageWindow {
  const pages = Math.max(1, Math.ceil(total / size));
  const shown = Math.min(Math.max(1, page), pages);
  const offset = (shown - 1) * size;
  return {
    page: shown,
    pages,
    offset,
    first: total === 0 ? 0 : offset + 1,
    last: Math.min(offset + size, total),
    hasPrevious: shown > 1,
    hasNext: shown < pages,
  };
}

/** The page that still shows the first row of `page` after the page size changes from `oldSize` to `newSize`. */
export function pageAfterResize(page: number, oldSize: number, newSize: number): number {
  return Math.floor(((Math.max(1, page) - 1) * oldSize) / newSize) + 1;
}

/** One slot of the row of page numbers: a page, or the ellipsis that stands for the pages left out before or after the numbers shown. */
export type PageItem = number | 'gap-before' | 'gap-after';

/** How many slots the row of page numbers has when the list has more pages than that. */
const pageSlots = 7;

/**
 * The row of page numbers for a list of `pages` pages with `page` shown. The first and the last page are always in it, so
 * they are the way to jump to either end; the pages around the current one come between, and an ellipsis stands for the
 * rest. With more than seven pages the row has exactly seven slots wherever the current page is, so the buttons never move
 * when the owner turns the pages.
 */
export function pageItems(pages: number, page: number): PageItem[] {
  if (pages <= pageSlots) {
    return Array.from({ length: pages }, (_, index) => index + 1);
  }
  const current = Math.min(Math.max(1, page), pages);
  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'gap-after', pages];
  }
  if (current >= pages - 3) {
    return [1, 'gap-before', pages - 4, pages - 3, pages - 2, pages - 1, pages];
  }
  return [1, 'gap-before', current - 1, current, current + 1, 'gap-after', pages];
}
