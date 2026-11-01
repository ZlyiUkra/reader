import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { test } from 'node:test';

/**
 * The page never turns document text into markup (T058, FR-055, C15). Document text, fragments, file names and reason
 * messages reach the page as strings, and React sets a string as the text of its element; the only ways around that are the
 * few APIs below, and none of them may appear in the page's sources. The same rule is checked in a real browser at the end
 * of the slice with hostile text in a file name and in a quoted fragment; this test keeps it true afterwards. It is a
 * source check, not a proof: it catches the way the rule is broken by a later edit, which is the way it gets broken.
 */
const webSrc = path.join(import.meta.dirname, '..', 'web', 'src');

/** Every `.ts` and `.tsx` file under the page's sources. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sources(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** What turns a string into markup or code, or into a navigation the server did not offer. */
const forbidden: Array<[RegExp, string]> = [
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|createContextualFragment|DOMParser/, 'a DOM API that parses markup'],
  [/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/, 'a way to run text as code'],
  [/\bmarked\b|markdown-it|react-markdown|remark|sanitize-html|dompurify/i, 'a markdown or HTML library'],
  [/\bstyle=\{/, 'an inline style (the page policy allows none)'],
  [/\bhref=\{/, 'a link built from data'],
];

test('the page sources use none of the APIs that parse text as markup', async () => {
  const files = await sources(webSrc);
  assert.ok(files.length >= 10, 'the sources were found');
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const [pattern, name] of forbidden) {
      assert.ok(!pattern.test(text), `${path.relative(webSrc, file)} uses ${name}`);
    }
  }
});

test('the views that show document text set it as the text of an element', async () => {
  for (const name of ['views/Documents.tsx', 'components/DocumentCard.tsx', 'components/ReasonList.tsx']) {
    const text = await readFile(path.join(webSrc, name), 'utf8');
    assert.ok(/\{[^}]*(originalName|verbatim|reasonText|valueText)[^}]*\}/.test(text), `${name} renders document text through a JSX expression`);
  }
});

test('the page images come from the API route of the document, never from a path or an address in the data', async () => {
  const text = await readFile(path.join(webSrc, 'components/DocumentCard.tsx'), 'utf8');
  const sources = [...text.matchAll(/src=\{(`[^`]*`)\}/g)].map((match) => match[1] ?? '');
  assert.ok(!/src=\{[^`]/.test(text), 'every image source is a template of the API route');
  assert.equal(sources.length, 1, 'one image element');
  assert.match(sources[0] ?? '', /^`api\/documents\/\$\{detail\.number\}\/pages\/\$\{page\.page\}\.png`$/);
});
