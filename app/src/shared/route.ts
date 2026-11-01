/**
 * The addresses of the page (FR-060), as a pure module shared with the tests: the page keeps its place in the hash of
 * its own URL, so a link, a reload and the browser's Back button all mean something, and no router library is needed.
 * Five addresses exist: `#/folder`, `#/folder/<file name>`, `#/documents`, `#/documents/<number>` and `#/types`. A file
 * name is the owner's own text and may hold any character, so it is URL-encoded as one segment. An address the page
 * does not know shows the folder, and a number that is not a positive integer shows the documents list: a mistyped
 * address never ends in an empty page.
 */

/** Where the page is: a view, and for the folder and the documents the item whose window is open, if any. */
export type Route =
  | { view: 'folder'; file: string | null }
  | { view: 'documents'; number: number | null }
  | { view: 'types' };

/** The address the page shows when it is opened without one, or with one it does not know. */
export const defaultRoute: Route = { view: 'folder', file: null };

/** A positive integer in plain digits: "17" is a document number, "017", "1.5", "-3" and "1e3" are not. */
function documentNumber(segment: string): number | null {
  if (!/^[1-9][0-9]*$/.test(segment)) {
    return null;
  }
  const number = Number(segment);
  return Number.isSafeInteger(number) ? number : null;
}

/** Decodes one URL segment, or null when its percent escapes are malformed. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Reads the hash of the page's URL (with or without the leading `#`) into a route. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  const segments = path.split('/').slice(1);
  const [view, item, ...rest] = segments;
  if (!path.startsWith('/') || rest.length > 0) {
    return defaultRoute;
  }
  if (view === 'folder') {
    const file = item === undefined ? null : decode(item);
    return { view: 'folder', file: file === '' ? null : file };
  }
  if (view === 'documents') {
    return { view: 'documents', number: item === undefined ? null : documentNumber(item) };
  }
  if (view === 'types' && item === undefined) {
    return { view: 'types' };
  }
  return defaultRoute;
}

/** The hash that opens a route; `parseRoute(routeHash(route))` gives the route back. */
export function routeHash(route: Route): string {
  if (route.view === 'folder') {
    return route.file === null || route.file === '' ? '#/folder' : `#/folder/${encodeURIComponent(route.file)}`;
  }
  if (route.view === 'documents') {
    return route.number === null ? '#/documents' : `#/documents/${route.number}`;
  }
  return '#/types';
}
