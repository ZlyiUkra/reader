import type { Failure } from './failures.ts';

/**
 * The two reading-quality rules of the parse step (research R14, FR-016): a document whose pages are mostly blank is
 * `EMPTY`, and a document whose OCR pages are mostly unreadable is `LOW_OCR_QUALITY`. Both lead to NEEDS_REVIEW before any
 * model call. The functions are pure and take the numbers as arguments, so a table test covers them and the thresholds
 * file stays the only place the numbers live.
 */

/** The three numbers the rules use, from `quality.*` in the thresholds file. */
export type QualityRules = {
  /** A page with fewer non-whitespace characters than this is blank. */
  emptyMinChars: number;
  /** An OCR page with a larger share of low-confidence words than this is low quality. */
  ocrLowShare: number;
  /** The confidence under which a word counts as low; stored in the reason so its text can say it. */
  ocrLowConfidence: number;
};

/** What the rules need to know about one page. */
export type PageFacts = {
  text: string;
  source: 'text_layer' | 'ocr';
  ocrWordsTotal: number | null;
  ocrWordsLow: number | null;
};

/** True when the page has fewer non-whitespace characters than the minimum. */
export function isBlank(page: PageFacts, rules: QualityRules): boolean {
  return page.text.replace(/\s/gu, '').length < rules.emptyMinChars;
}

/** True for an OCR page that has words and a larger share of low-confidence ones than allowed. */
export function isLowQuality(page: PageFacts, rules: QualityRules): boolean {
  const total = page.ocrWordsTotal ?? 0;
  return page.source === 'ocr' && total > 0 && (page.ocrWordsLow ?? 0) / total > rules.ocrLowShare;
}

/**
 * The reasons the readings of a document call for: `EMPTY` when more than half of the pages are blank, otherwise
 * `LOW_OCR_QUALITY` when more than half of the OCR pages that have words are low quality, otherwise none. A blank document
 * is not also reported as unreadable, because "nothing to read" is the better explanation.
 */
export function readingReasons(pages: PageFacts[], rules: QualityRules): Failure[] {
  const blankPages = pages.filter((page) => isBlank(page, rules)).length;
  if (pages.length > 0 && blankPages * 2 > pages.length) {
    return [{ code: 'EMPTY', params: { blankPages, pages: pages.length, minChars: rules.emptyMinChars } }];
  }
  const ocrPages = pages.filter((page) => page.source === 'ocr' && (page.ocrWordsTotal ?? 0) > 0);
  const lowPages = ocrPages.filter((page) => isLowQuality(page, rules)).length;
  if (ocrPages.length > 0 && lowPages * 2 > ocrPages.length) {
    return [{ code: 'LOW_OCR_QUALITY', params: { lowPages, ocrPages: ocrPages.length, share: rules.ocrLowShare, minConfidence: rules.ocrLowConfidence } }];
  }
  return [];
}
