import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { pageSettings } from '../src/config/page-settings.ts';
import { pageAfterResize, pageItems, pageWindow } from '../src/shared/pager.ts';
import type { PageItem } from '../src/shared/pager.ts';

/**
 * The arithmetic of the lists shown in pages and the rows that set their size (T078, FR-053): where a page lies, which way
 * it can move, how a page is brought into range, which page keeps the first visible row after the size changes, and what
 * the thresholds file may say about the sizes. The controls of the page are drawn from this window and nothing else, so what
 * is tested here is exactly when each button is enabled.
 */
const config = await loadConfig(resolveConfigDirs(process.env));

test('the window of a page: its place, its rows and the way it can move', () => {
  const cases: Array<[string, number, number, number, object]> = [
    ['an empty list is one empty page', 0, 20, 1, { page: 1, pages: 1, offset: 0, first: 0, last: 0, hasPrevious: false, hasNext: false }],
    ['a list that fits is one page', 20, 20, 1, { page: 1, pages: 1, offset: 0, first: 1, last: 20, hasPrevious: false, hasNext: false }],
    ['one row over makes a second page with one row', 21, 20, 2, { page: 2, pages: 2, offset: 20, first: 21, last: 21, hasPrevious: true, hasNext: false }],
    ['the first page of many can only go forward', 134, 20, 1, { page: 1, pages: 7, offset: 0, first: 1, last: 20, hasPrevious: false, hasNext: true }],
    ['a middle page can go both ways', 134, 20, 4, { page: 4, pages: 7, offset: 60, first: 61, last: 80, hasPrevious: true, hasNext: true }],
    ['the last page is the short one', 134, 20, 7, { page: 7, pages: 7, offset: 120, first: 121, last: 134, hasPrevious: true, hasNext: false }],
    ['a page past the end comes back to the last', 134, 20, 99, { page: 7, pages: 7, offset: 120, first: 121, last: 134, hasPrevious: true, hasNext: false }],
    ['a page before the first comes to the first', 134, 20, 0, { page: 1, pages: 7, offset: 0, first: 1, last: 20, hasPrevious: false, hasNext: true }],
    ['a page larger than the list shows all of it', 3, 100, 1, { page: 1, pages: 1, offset: 0, first: 1, last: 3, hasPrevious: false, hasNext: false }],
  ];
  for (const [name, total, size, page, expected] of cases) {
    assert.deepEqual(pageWindow(total, size, page), expected, name);
  }
});

test('a change of the page size keeps the first visible row on the page', () => {
  const cases: Array<[number, number, number, number]> = [
    [1, 20, 10, 1],
    [2, 20, 10, 3],
    [3, 20, 100, 1],
    [7, 20, 50, 3],
    [2, 10, 20, 1],
    [5, 10, 20, 3],
    [1, 50, 10, 1],
  ];
  for (const [page, oldSize, newSize, expected] of cases) {
    const after = pageAfterResize(page, oldSize, newSize);
    assert.equal(after, expected, `page ${page} of ${oldSize} to ${newSize}`);
    const before = (page - 1) * oldSize;
    const start = (after - 1) * newSize;
    assert.ok(start <= before && before < start + newSize, 'the first row of the old page is on the new one');
  }
});

test('the real thresholds file gives a default size that is one of the choices', () => {
  const settings = pageSettings(config.thresholds);
  assert.equal(settings.pageSize, 20);
  assert.deepEqual(settings.pageSizes, [10, 20, 50, 100]);
});

test('a size row that cannot be used stops the start, naming its key', () => {
  const withRows = (size: unknown, options: unknown) => {
    const copy = structuredClone(config.thresholds);
    const entry = (value: unknown) => ({ value, unit: 'rows', status: 'provisional' as const, source: 'test' });
    Object.assign(copy.values, { 'ui.page_size': entry(size), 'ui.page_size_options': entry(options) });
    return copy;
  };
  const refused: Array<[string, unknown, unknown, RegExp]> = [
    ['a default that is not a number', 'twenty', '10,20', /ui\.page_size" must be a whole number/],
    ['a fractional default', 2.5, '10,20', /ui\.page_size" must be a whole number/],
    ['options that are not a list', 20, 20, /ui\.page_size_options" must be a comma-separated list/],
    ['an option that is not a number', 20, '10,x,50', /ui\.page_size_options" must list whole numbers/],
    ['an option of zero', 20, '0,20', /ui\.page_size_options" must list whole numbers/],
    ['an option above what the API serves', 20, '10,20,5000', /ui\.page_size_options" must list whole numbers/],
    ['options out of order', 20, '50,20,10', /ui\.page_size_options" must list whole numbers/],
    ['a repeated option', 20, '10,20,20', /ui\.page_size_options" must list whole numbers/],
    ['a default that is not offered', 30, '10,20,50', /ui\.page_size" must be one of/],
  ];
  for (const [name, size, options, message] of refused) {
    assert.throws(() => pageSettings(withRows(size, options)), message, name);
  }
});

test('the row of page numbers: first and last always there, seven slots when there are more pages than that', () => {
  const cases: Array<[string, number, number, PageItem[]]> = [
    ['one page', 1, 1, [1]],
    ['a few pages show all', 5, 3, [1, 2, 3, 4, 5]],
    ['seven pages show all', 7, 4, [1, 2, 3, 4, 5, 6, 7]],
    ['the start of many', 10, 1, [1, 2, 3, 4, 5, 'gap-after', 10]],
    ['the fourth of many still shows the start', 10, 4, [1, 2, 3, 4, 5, 'gap-after', 10]],
    ['the middle of many has a gap on each side', 10, 5, [1, 'gap-before', 4, 5, 6, 'gap-after', 10]],
    ['near the end of many', 10, 7, [1, 'gap-before', 6, 7, 8, 9, 10]],
    ['the end of many', 10, 10, [1, 'gap-before', 6, 7, 8, 9, 10]],
    ['eight pages, the fifth', 8, 5, [1, 'gap-before', 4, 5, 6, 7, 8]],
    ['a page out of range is brought into it', 10, 99, [1, 'gap-before', 6, 7, 8, 9, 10]],
  ];
  for (const [name, pages, page, expected] of cases) {
    assert.deepEqual(pageItems(pages, page), expected, name);
  }
  for (let pages = 1; pages <= 40; pages++) {
    for (let page = 1; page <= pages; page++) {
      const items = pageItems(pages, page);
      const numbers = items.filter((item): item is number => typeof item === 'number');
      assert.equal(items.length, Math.min(pages, 7), `${pages} pages, page ${page}: the number of slots`);
      assert.ok(numbers.includes(1) && numbers.includes(pages) && numbers.includes(page), `${pages} pages, page ${page}: first, last and current`);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'ascending');
      items.forEach((item, index) => {
        if (typeof item === 'string') {
          const before = items[index - 1];
          const after = items[index + 1];
          assert.ok(typeof before === 'number' && typeof after === 'number' && after - before > 1, `${pages} pages, page ${page}: a gap hides at least one page`);
        }
      });
    }
  }
});
