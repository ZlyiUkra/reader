import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, defaultRoute, parseLocation, parseRoute, routeHash } from '../src/shared/route.ts';
import type { Route } from '../src/shared/route.ts';

/**
 * The six addresses of the page and what happens to every other (FR-060, FR-067): the parse and the build are inverses for
 * the routes the page makes, the empty address is the default page, and any other address is not found, never an empty
 * page and never a page that only looks right.
 */

const known: Array<{ hash: string; route: Route }> = [
  { hash: '#/folder', route: { view: 'folder', file: null } },
  { hash: '#/folder/invoice-1.pdf', route: { view: 'folder', file: 'invoice-1.pdf' } },
  { hash: '#/documents', route: { view: 'documents', number: null } },
  { hash: '#/documents/17', route: { view: 'documents', number: 17 } },
  { hash: '#/types', route: { view: 'types' } },
  { hash: '#/simplifications', route: { view: 'simplifications' } },
];

test('the six addresses are read into their routes and built back', () => {
  for (const { hash, route } of known) {
    assert.deepEqual(parseRoute(hash), route, hash);
    assert.equal(routeHash(route), hash);
  }
});

test('the leading hash sign is optional when parsing', () => {
  assert.deepEqual(parseRoute('/documents/3'), { view: 'documents', number: 3 });
  assert.deepEqual(parseRoute('/types'), { view: 'types' });
  assert.deepEqual(parseRoute('/simplifications'), { view: 'simplifications' });
});

test('a file name travels as one encoded segment, whatever characters it has', () => {
  const names = ['a b.pdf', 'a/b.pdf', '100% done.docx', 'Договір №1 (копія).docx', '..', '#hash?.txt', "it's.png"];
  for (const file of names) {
    const hash = routeHash({ view: 'folder', file });
    assert.ok(!hash.slice('#/folder/'.length).includes('/'), `${file} leaked a slash into ${hash}`);
    assert.deepEqual(parseRoute(hash), { view: 'folder', file }, file);
  }
});

test('an empty address is the default page', () => {
  for (const hash of ['', '#', '#/', '/']) {
    assert.deepEqual(parseRoute(hash), defaultRoute, JSON.stringify(hash));
  }
});

test('an address the page does not know is not found, with the address as typed', () => {
  for (const hash of ['#folder', '#/nothing', '#/folder/a/b', '#/documents/1/2', '#/types/invoice', '#/simplifications/x', '#/Simplifications', '#/%E0%A4%A', 'documents', '#/folder/%E0%A4%A']) {
    assert.deepEqual(parseRoute(hash), { view: 'notFound', address: hash }, JSON.stringify(hash));
  }
});

test('an empty file name or document number is the list without a window', () => {
  assert.deepEqual(parseRoute('#/folder/'), { view: 'folder', file: null });
  assert.deepEqual(parseRoute('#/documents/'), { view: 'documents', number: null });
});

test('a document number that is not a positive integer is not found', () => {
  for (const segment of ['0', '-1', '1.5', '017', 'abc', '1e3', '99999999999999999999', ' 7']) {
    assert.deepEqual(parseRoute(`#/documents/${segment}`), { view: 'notFound', address: `#/documents/${segment}` }, segment);
  }
});

test('the not-found address has an underscore of its own, carries the typed address as one segment and reads back', () => {
  const addresses = ['#/nothing', '/a/b/c?x=1', '#/documents/abc', 'Договір №1', '#/_404/#/_404', ''];
  for (const address of addresses) {
    const route: Route = { view: 'notFound', address };
    const hash = routeHash(route);
    assert.ok(hash.startsWith('#/_404'), hash);
    assert.ok(!hash.slice('#/_404/'.length).includes('/'), `${address} leaked a slash into ${hash}`);
    assert.deepEqual(parseRoute(hash), route, address);
  }
  assert.equal(routeHash({ view: 'notFound', address: '#/nothing' }), '#/_404/%23%2Fnothing');
  assert.equal(canonicalUrl({ view: 'notFound', address: '/x' }), '/#/_404/%2Fx');
  assert.equal(canonicalUrl({ view: 'documents', number: 17 }), '/#/documents/17');
});

test('a path other than the root is not found with the path and query as typed; at the root the hash decides', () => {
  assert.deepEqual(parseLocation('/nothing', '', '#/folder'), { view: 'notFound', address: '/nothing' });
  assert.deepEqual(parseLocation('/a/b/c', '?x=1', ''), { view: 'notFound', address: '/a/b/c?x=1' });
  assert.deepEqual(parseLocation('/', '', ''), defaultRoute);
  assert.deepEqual(parseLocation('/', '?x=1', '#/types'), { view: 'types' });
  assert.deepEqual(parseLocation('/index.html', '', '#/documents/3'), { view: 'documents', number: 3 });
  assert.deepEqual(parseLocation('/', '', '#/nothing'), { view: 'notFound', address: '#/nothing' });
});
