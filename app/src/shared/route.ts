/**
 * The addresses of the page (FR-060, FR-067), as a pure module shared with the tests: the page keeps its place in the
 * hash of its own URL, so a link, a reload and the browser's Back button all mean something, and no router library is
 * needed. Six addresses exist: `#/folder`, `#/folder/<file name>`, `#/documents`, `#/documents/<number>`, `#/types` and
 * `#/simplifications`. A file name is the owner's own text and may hold any character, so it is URL-encoded as one
 * segment. The empty address is the default page. Every other address, a hash or a path, is not found: it is shown at an
 * address of its own, `#/_404/<the address as typed>`, whose underscore keeps it from ever matching a document number or
 * a view, so a mistyped address never ends in an empty page or in a page that only looks right.
 */

/** Where the page is: a view, and for the folder and the documents the item whose window is open, if any. */
export type Route =
  | { view: 'folder'; file: string | null }
  | { view: 'documents'; number: number | null }
  | { view: 'types' }
  | { view: 'simplifications' }
  | { view: 'notFound'; address: string };

/** The page shown when the address is empty and the one the not-found page leads to: the one place that names it. */
export const defaultRoute: Route = { view: 'folder', file: null };

/** The first segment of the not-found address; the underscore is what no view, number or file name starts with. */
const notFoundSegment = '_404';

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

/**
 * Reads the hash of the page's URL (with or without the leading `#`) into a route: an empty hash is the default page, one
 * of the six addresses is its view, and anything else is a not-found route that keeps the hash as typed. A trailing slash
 * after `folder` or `documents` is the list without a window.
 */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '' || path === '/') {
    return defaultRoute;
  }
  const unknown: Route = { view: 'notFound', address: hash };
  if (!path.startsWith('/')) {
    return unknown;
  }
  const [view, item, ...rest] = path.split('/').slice(1);
  if (rest.length > 0) {
    return unknown;
  }
  if (view === 'folder') {
    const file = item === undefined ? null : decode(item);
    return file === null && item !== undefined ? unknown : { view: 'folder', file: file === '' ? null : file };
  }
  if (view === 'documents') {
    if (item === undefined || item === '') {
      return { view: 'documents', number: null };
    }
    const number = documentNumber(item);
    return number === null ? unknown : { view: 'documents', number };
  }
  if ((view === 'types' || view === 'simplifications') && item === undefined) {
    return { view };
  }
  if (view === notFoundSegment) {
    return { view: 'notFound', address: item === undefined ? '' : (decode(item) ?? item) };
  }
  return unknown;
}

/**
 * Reads where the browser is, path and hash together: the page lives at the root, so any other path (`/nothing`,
 * `/a/b/c?x=1`) is a not-found route that keeps the path and the query as typed; at the root the hash decides.
 */
export function parseLocation(pathname: string, search: string, hash: string): Route {
  if (pathname !== '/' && pathname !== '/index.html') {
    return { view: 'notFound', address: pathname + search };
  }
  return parseRoute(hash);
}

/** The hash that opens a route; `parseRoute(routeHash(route))` gives the route back. */
export function routeHash(route: Route): string {
  if (route.view === 'folder') {
    return route.file === null || route.file === '' ? '#/folder' : `#/folder/${encodeURIComponent(route.file)}`;
  }
  if (route.view === 'documents') {
    return route.number === null ? '#/documents' : `#/documents/${route.number}`;
  }
  if (route.view === 'notFound') {
    return route.address === '' ? `#/${notFoundSegment}` : `#/${notFoundSegment}/${encodeURIComponent(route.address)}`;
  }
  return route.view === 'types' ? '#/types' : '#/simplifications';
}

/** The address the bar should hold for a route: the root path and the hash of the route, whatever the bar holds now. */
export function canonicalUrl(route: Route): string {
  return `/${routeHash(route)}`;
}
