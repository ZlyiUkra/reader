/**
 * How the page tells that the server now serves a newer build than the one it was loaded from (FR-059). The bundler names
 * every built file of the page after its content (`assets/index-<hash>.js`, `assets/index-<hash>.css`), so the files the
 * served HTML names are the identity of a build and nothing else has to be kept or compared. The page reads the same files
 * from its own `<script>` and `<link>` elements and asks for the served HTML now and then; no server state and no API
 * are involved. The logic is plain text work so that it is tested without a browser.
 */

/** One built file of the page as the bundler names it, with or without a leading `./`. */
const assetPattern = /assets\/[A-Za-z0-9._-]+\.(?:js|css)/g;

/** The built files a text names (an HTML page, or the attributes of its elements), each once, in a fixed order. */
export function assetsOf(text: string): string[] {
  return [...new Set(text.match(assetPattern) ?? [])].sort();
}

/**
 * True when the HTML now served names other built files than the ones the running page came from. A page that names no
 * built file, on either side (an error page, the answer of a proxy, a development server), is never taken for a new build:
 * a wrong "new version" message is worse than a late one.
 */
export function isNewBuild(running: string[], servedHtml: string): boolean {
  const served = assetsOf(servedHtml);
  return running.length > 0 && served.length > 0 && served.join('|') !== running.join('|');
}
