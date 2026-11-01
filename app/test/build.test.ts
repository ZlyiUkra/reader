import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetsOf, isNewBuild } from '../src/shared/build.ts';

/**
 * How the page tells a newer build from the one it runs (T086, FR-059): the built files the served HTML names against
 * the ones the running page was loaded from. The samples follow the HTML the bundler writes for this page.
 */
const served = (script: string, style: string): string =>
  `<!doctype html><html><head><script type="module" crossorigin src="./assets/${script}"></script><link rel="stylesheet" crossorigin href="./assets/${style}"></head><body><div id="root"></div></body></html>`;

test('the built files of a page are found once each, in a fixed order, with or without a leading dot', () => {
  assert.deepEqual(assetsOf(served('index-AAA.js', 'index-BBB.css')), ['assets/index-AAA.js', 'assets/index-BBB.css']);
  assert.deepEqual(assetsOf('/assets/index-AAA.js\n./assets/index-AAA.js\nassets/index-BBB.css'), ['assets/index-AAA.js', 'assets/index-BBB.css']);
  assert.deepEqual(assetsOf('<html><body>nothing built here</body></html>'), []);
});

test('a build is new when the served HTML names other files, and only then', () => {
  const running = assetsOf(served('index-AAA.js', 'index-BBB.css'));
  const cases: Array<[string, string, boolean]> = [
    ['the same files are not new', served('index-AAA.js', 'index-BBB.css'), false],
    ['a new script is new', served('index-CCC.js', 'index-BBB.css'), true],
    ['a new style sheet alone is new', served('index-AAA.js', 'index-DDD.css'), true],
    ['an error page without built files is not new', '<html><body>502 Bad Gateway</body></html>', false],
    ['an empty answer is not new', '', false],
  ];
  for (const [name, html, expected] of cases) {
    assert.equal(isNewBuild(running, html), expected, name);
  }
});

test('a running page that names no built file never reports a new build', () => {
  assert.equal(isNewBuild([], served('index-AAA.js', 'index-BBB.css')), false);
});
