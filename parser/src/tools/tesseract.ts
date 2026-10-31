import { readFile } from 'node:fs/promises';
import { runTool } from './run.ts';
import type { ToolBudget } from './run.ts';

/** The text of one page read by OCR, its word table and how many words the engine was unsure of. */
export type OcrResult = {
  text: string;
  tsv: string;
  wordsTotal: number;
  wordsLow: number;
};

/**
 * Counts the words of a Tesseract `tsv` table and those with a confidence below `lowBelow`. Only rows of level 5 (a
 * word) with some text count; the other levels carry a confidence of -1. The share of low words is what the pipeline
 * turns into `LOW_OCR_QUALITY`, so the parser only counts and does not judge.
 */
export function ocrWordStats(tsv: string, lowBelow: number): { wordsTotal: number; wordsLow: number } {
  let wordsTotal = 0;
  let wordsLow = 0;
  for (const line of tsv.split('\n').slice(1)) {
    const columns = line.split('\t');
    if (columns[0] !== '5' || (columns[11] ?? '').trim() === '') {
      continue;
    }
    wordsTotal += 1;
    if (Number(columns[10]) < lowBelow) {
      wordsLow += 1;
    }
  }
  return { wordsTotal, wordsLow };
}

/**
 * Reads an image with Tesseract in one pass that writes both the text and the word table (`txt tsv`), Ukrainian and
 * English together, automatic page segmentation without orientation detection (R8). The output files are written next
 * to `base` and read back.
 */
export async function ocrImage(image: string, base: string, lowBelow: number, budget: ToolBudget): Promise<OcrResult> {
  await runTool('tesseract', [image, base, '-l', 'ukr+eng', '--psm', '3', 'txt', 'tsv'], budget);
  const text = (await readFile(`${base}.txt`, 'utf8')).replace(/\f$/, '');
  const tsv = await readFile(`${base}.tsv`, 'utf8');
  return { text, tsv, ...ocrWordStats(tsv, lowBelow) };
}

/** The version of Tesseract from the first line of `tesseract --version`, such as `5.3.0`. */
export async function tesseractVersion(budget: ToolBudget): Promise<string> {
  const { stdout, stderr } = await runTool('tesseract', ['--version'], budget);
  return /tesseract\s+(\S+)/.exec(`${stdout.toString('utf8')}\n${stderr}`)?.[1] ?? 'unknown';
}
