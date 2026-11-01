import React from 'react';
import { pageAfterResize, pageWindow } from '@shared/pager.ts';
import type { Meta } from './api/answers.ts';

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

/** The controls of the two lists, each null until the page sizes have arrived from the server. */
export type ListPagers = { folder: PagerControls | null; documents: PagerControls | null };

/**
 * The paging of both lists in one place (FR-053, FR-064). The page size is one choice for both lists and starts as the
 * server's default once `meta` has arrived; each list has its own page, and a change of the size moves each list to the
 * page that still shows the row it started at. The state lives above the views, because the views come and go as the owner
 * moves between them and the lists keep their place.
 */
export function usePagers(meta: Meta | null): ListPagers {
  const [size, setSize] = React.useState<number | null>(null);
  const [folderPage, setFolderPage] = React.useState(1);
  const [documentsPage, setDocumentsPage] = React.useState(1);

  React.useEffect(() => {
    if (meta !== null) {
      setSize((current) => current ?? meta.pageSize);
    }
  }, [meta]);

  /** Changes the page size of both lists and moves each to the page that still shows the row it started at. */
  function changeSize(next: number): void {
    const previous = size ?? next;
    setFolderPage((page) => pageAfterResize(page, previous, next));
    setDocumentsPage((page) => pageAfterResize(page, previous, next));
    setSize(next);
  }

  function controlsOf(page: number, onPage: (page: number) => void): PagerControls | null {
    return meta === null || size === null ? null : { sizes: meta.pageSizes, size, page, onPage, onSize: changeSize };
  }

  return { folder: controlsOf(folderPage, setFolderPage), documents: controlsOf(documentsPage, setDocumentsPage) };
}

/**
 * Brings a list's page back to the last one that exists when the list shrank or the size grew, so the owner never sits on
 * an empty page past the end. Written once here and called by each list with the number of rows it has.
 */
export function useFitPage(controls: PagerControls | null, total: number | undefined): void {
  const size = controls?.size;
  const page = controls?.page;
  const onPage = controls?.onPage;
  React.useEffect(() => {
    if (total !== undefined && size !== undefined && page !== undefined && onPage !== undefined) {
      const inRange = pageWindow(total, size, page).page;
      if (inRange !== page) {
        onPage(inRange);
      }
    }
  }, [total, size, page, onPage]);
}

/** The rows of the page shown, for a list the server sends whole and the page cuts here. */
export function rowsOfPage<Row>(rows: Row[], controls: PagerControls): Row[] {
  const { offset } = pageWindow(rows.length, controls.size, controls.page);
  return rows.slice(offset, offset + controls.size);
}
