import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingReasons } from '../src/pipeline/quality.ts';
import type { PageFacts, QualityRules } from '../src/pipeline/quality.ts';

/**
 * The two reading-quality rules (research R14, FR-016), as a table: what the readings of a document call for, from the
 * numbers of `quality.*`. The hostile files of the fixtures set are the real cases: a blank page and a page of noise.
 */
const rules: QualityRules = { emptyMinChars: 20, ocrLowShare: 0.4, ocrLowConfidence: 60 };

const text = (characters: number): string => 'a'.repeat(characters);
const layer = (characters: number): PageFacts => ({ text: text(characters), source: 'text_layer', ocrWordsTotal: null, ocrWordsLow: null });
const ocr = (characters: number, total: number, low: number): PageFacts => ({ text: text(characters), source: 'ocr', ocrWordsTotal: total, ocrWordsLow: low });

const cases: Array<{ name: string; pages: PageFacts[]; codes: string[]; params?: Record<string, number> }> = [
  { name: 'a readable text page', pages: [layer(400)], codes: [] },
  { name: 'a readable OCR page with a few low words', pages: [ocr(400, 70, 5)], codes: [] },
  { name: 'the blank page (no characters, no words)', pages: [ocr(0, 0, 0)], codes: ['EMPTY'], params: { blankPages: 1, pages: 1, minChars: 20 } },
  { name: 'only whitespace counts as blank', pages: [{ text: ' \n\t  \n ', source: 'text_layer', ocrWordsTotal: null, ocrWordsLow: null }], codes: ['EMPTY'] },
  { name: 'the noise page (words, almost all low)', pages: [ocr(162, 79, 76)], codes: ['LOW_OCR_QUALITY'], params: { lowPages: 1, ocrPages: 1, minConfidence: 60 } },
  { name: 'exactly half of the pages blank is not empty', pages: [layer(400), layer(0)], codes: [] },
  { name: 'more than half of the pages blank is empty', pages: [layer(400), layer(0), layer(3)], codes: ['EMPTY'], params: { blankPages: 2, pages: 3, minChars: 20 } },
  { name: 'one low page of three OCR pages is not low quality', pages: [ocr(400, 70, 5), ocr(400, 70, 5), ocr(400, 70, 60)], codes: [] },
  { name: 'two low pages of three OCR pages is low quality', pages: [ocr(400, 70, 5), ocr(400, 70, 60), ocr(400, 70, 60)], codes: ['LOW_OCR_QUALITY'], params: { lowPages: 2, ocrPages: 3, minConfidence: 60 } },
  { name: 'a low share exactly at the limit is not low', pages: [ocr(400, 10, 4)], codes: [] },
  { name: 'text-layer pages are never low quality', pages: [layer(400), layer(400)], codes: [] },
  { name: 'a blank document is not also reported as unreadable', pages: [ocr(0, 0, 0), ocr(0, 0, 0)], codes: ['EMPTY'] },
  { name: 'a document without pages has nothing to judge', pages: [], codes: [] },
];

for (const { name, pages, codes, params } of cases) {
  test(`reading reasons: ${name}`, () => {
    const reasons = readingReasons(pages, rules);
    assert.deepEqual(reasons.map((reason) => reason.code), codes);
    if (params !== undefined) {
      assert.deepEqual(Object.fromEntries(Object.entries(reasons[0]?.params ?? {}).filter(([key]) => key in params)), params);
    }
  });
}
