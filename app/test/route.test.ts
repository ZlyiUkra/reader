import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRoute, parseRoute, routeHash } from '../src/shared/route.ts';
import type { Route } from '../src/shared/route.ts';

/**
 * The five addresses of the page and what happens to every other (FR-060): the parse and the build are inverses for the
 * routes the page makes, and a hash from anywhere else lands on the folder or the list, never on nothing.
 */

const known: Array<{ hash: string; route: Route }> = [
  { hash: '#/folder', route: { view: 'folder', file: null } },
  { hash: '#/folder/invoice-1.pdf', route: { view: 'folder', file: 'invoice-1.pdf' } },
  { hash: '#/documents', route: { view: 'documents', number: null } },
  { hash: '#/documents/17', route: { view: 'documents', number: 17 } },
  { hash: '#/types', route: { view: 'types' } },
];

test('the five addresses are read into their routes and built back', () => {
  for (const { hash, route } of known) {
    assert.deepEqual(parseRoute(hash), route, hash);
    assert.equal(routeHash(route), hash);
  }
});

test('the leading hash sign is optional when parsing', () => {
  assert.deepEqual(parseRoute('/documents/3'), { view: 'documents', number: 3 });
  assert.deepEqual(parseRoute('/types'), { view: 'types' });
});

test('a file name travels as one encoded segment, whatever characters it has', () => {
  const names = ['a b.pdf', 'a/b.pdf', '100% done.docx', 'Договір №1 (копія).docx', '..', '#hash?.txt', "it's.png"];
  for (const file of names) {
    const hash = routeHash({ view: 'folder', file });
    assert.ok(!hash.slice('#/folder/'.length).includes('/'), `${file} leaked a slash into ${hash}`);
    assert.deepEqual(parseRoute(hash), { view: 'folder', file }, file);
  }
});

test('an address the page does not know shows the folder', () => {
  for (const hash of ['', '#', '#/', '#folder', '#/nothing', '#/folder/a/b', '#/documents/1/2', '#/types/invoice', '#/%E0%A4%A', 'documents']) {
    assert.deepEqual(parseRoute(hash), defaultRoute, JSON.stringify(hash));
  }
});

test('a malformed file name falls back to the folder, an empty one to the list without a window', () => {
  assert.deepEqual(parseRoute('#/folder/%E0%A4%A'), defaultRoute);
  assert.deepEqual(parseRoute('#/folder/'), { view: 'folder', file: null });
});

test('a document number that is not a positive integer shows the list without a window', () => {
  for (const segment of ['0', '-1', '1.5', '017', 'abc', '1e3', '99999999999999999999', ' 7']) {
    assert.deepEqual(parseRoute(`#/documents/${segment}`), { view: 'documents', number: null }, segment);
  }
});
