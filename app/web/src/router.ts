import React from 'react';
import { parseRoute, routeHash } from '@shared/route.ts';
import type { Route } from '@shared/route.ts';

/**
 * The page's own routes over the hash of its URL (FR-060, FR-064): the pure parse and build live in `@shared/route.ts`
 * with their table test, and this module adds the browser's part, the current route as state and the two moves between
 * routes. There is no router library; the six addresses need none.
 */

/** True for a route that has a window open above its list: a file of the folder or a document. */
export function hasWindow(route: Route): boolean {
  return (route.view === 'folder' && route.file !== null) || (route.view === 'documents' && route.number !== null);
}

/** The list a window stands above: the same view without the open item. */
function listOf(route: Route): Route {
  if (route.view === 'folder') {
    return { view: 'folder', file: null };
  }
  return route.view === 'documents' ? { view: 'documents', number: null } : route;
}

/** The route the address bar holds now. */
function current(): Route {
  return parseRoute(window.location.hash);
}

/**
 * True while the window on screen was opened by a move of this page, so the browser's history has the list one step back and
 * closing can be a step back; a window reached by a pasted link or a reload has no such step and closing replaces it.
 */
let openedHere = false;

/** Goes to a route: the address changes, a new step enters the history, and the browser's Back returns to where the owner was. */
export function navigate(route: Route): void {
  openedHere = hasWindow(route) && !hasWindow(current());
  window.location.hash = routeHash(route);
}

/** Closes the window above the list: a step back if this page opened it, else the list takes its place in the history. */
export function closeWindow(): void {
  if (openedHere) {
    openedHere = false;
    window.history.back();
    return;
  }
  window.history.replaceState(null, '', routeHash(listOf(current())));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** The current route, kept in step with the address bar. An address the page does not know is rewritten to the one it shows. */
export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(current);

  React.useEffect(() => {
    const canonical = routeHash(current());
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, '', canonical);
    }
    const onChange = (): void => {
      const next = current();
      if (!hasWindow(next)) {
        openedHere = false;
      }
      setRoute(next);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
