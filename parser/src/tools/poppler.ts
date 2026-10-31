import { runTool, ToolError } from './run.ts';
import type { ToolBudget } from './run.ts';

/** What `pdfinfo` says about a document: how many pages it has and whether it is encrypted. */
export type PdfInfo = {
  pages: number;
  encrypted: boolean;
};

/** The size of one page in points (1/72 inch), as `pdfinfo -f 1 -l N` prints it. */
export type PageSize = {
  widthPt: number;
  heightPt: number;
};

/**
 * True when a `pdfinfo` or `qpdf` failure was a missing password. A PDF with a user password never prints
 * `Encrypted: yes`: the tool stops with "Incorrect password" and exit code 1 (measured 2026-10-31), so the parser maps
 * that message to `ENCRYPTED` as well as the `Encrypted: yes` line it can read from a file that opens without one.
 */
export function isPasswordFailure(error: unknown): boolean {
  return error instanceof ToolError && /incorrect password/i.test(error.stderr);
}

/** The number after a label in `pdfinfo` output, or null when the label is absent. */
function numberAfter(label: RegExp, text: string): number | null {
  const match = label.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Reads the page count and the encryption flag with `pdfinfo`. A file `pdfinfo` cannot read is a `ToolError`: the
 * caller decides between `ENCRYPTED` (see `isPasswordFailure`) and `CORRUPT`.
 */
export async function pdfinfo(pdf: string, budget: ToolBudget): Promise<PdfInfo> {
  const { stdout } = await runTool('pdfinfo', [pdf], budget);
  const text = stdout.toString('utf8');
  return { pages: numberAfter(/^Pages:\s+(\d+)/m, text) ?? 0, encrypted: /^Encrypted:\s+yes/m.test(text) };
}

/** The size of every page from 1 to `pages`, in order; a page whose size is not printed is a failure of the file. */
export async function pdfPageSizes(pdf: string, pages: number, budget: ToolBudget): Promise<PageSize[]> {
  const { stdout } = await runTool('pdfinfo', ['-f', '1', '-l', String(pages), pdf], budget);
  const sizes: PageSize[] = [];
  for (const match of stdout.toString('utf8').matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    sizes[Number(match[1]) - 1] = { widthPt: Number(match[2]), heightPt: Number(match[3]) };
  }
  if (sizes.length !== pages || sizes.some((size) => size === undefined)) {
    throw new ToolError('pdfinfo', 'exit', { exitCode: 0, stderr: 'the page sizes could not be read', elapsedMs: 0 });
  }
  return sizes;
}

/** The text layer of one page, as `pdftotext -layout` lays it out, without the form feed that ends the page. */
export async function pdfPageText(pdf: string, page: number, budget: ToolBudget): Promise<string> {
  const { stdout } = await runTool('pdftotext', ['-layout', '-enc', 'UTF-8', '-f', String(page), '-l', String(page), pdf, '-'], budget);
  return stdout.toString('utf8').replace(/\f$/, '');
}

/** Renders one page to `<base>.png`, scaled to a fixed width with the height following the page: the preview. */
export async function renderPreview(pdf: string, page: number, base: string, widthPx: number, budget: ToolBudget): Promise<string> {
  await runTool('pdftoppm', ['-png', '-scale-to-x', String(widthPx), '-scale-to-y', '-1', '-f', String(page), '-l', String(page), '-singlefile', pdf, base], budget);
  return `${base}.png`;
}

/** Renders one page to `<base>.png` at a resolution, the input of OCR. */
export async function renderForOcr(pdf: string, page: number, base: string, dpi: number, budget: ToolBudget): Promise<string> {
  await runTool('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', pdf, base], budget);
  return `${base}.png`;
}

/**
 * The resolution of the largest image on a page, in pixels per inch, from `pdfimages -list`, or null when the page
 * carries no image. A scanned page is one image; reading it above its own resolution adds no information, only render time
 * and noise (measured 2026-10-31: a 200 ppi scan took 10 s to render at 300 dpi and 1.5 s at 200, and read with a lower
 * mean confidence), so the OCR render never goes above this.
 */
export async function pdfImageDpi(pdf: string, page: number, budget: ToolBudget): Promise<number | null> {
  const { stdout } = await runTool('pdfimages', ['-list', '-f', String(page), '-l', String(page), pdf], budget);
  let best: { area: number; dpi: number } | null = null;
  for (const line of stdout.toString('utf8').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 15 || !/^\d+$/.test(columns[0] ?? '') || columns[2] !== 'image') {
      continue;
    }
    const area = Number(columns[3]) * Number(columns[4]);
    const dpi = Math.max(Number(columns[12]), Number(columns[13]));
    if (Number.isFinite(area) && Number.isFinite(dpi) && (best === null || area > best.area)) {
      best = { area, dpi };
    }
  }
  return best === null ? null : best.dpi;
}

/** The version of poppler-utils, read once from `pdftotext -v` (the tool prints it on standard error). */
export async function popplerVersion(budget: ToolBudget): Promise<string> {
  const { stderr } = await runTool('pdftotext', ['-v'], budget);
  return /version\s+(\S+)/.exec(stderr)?.[1] ?? 'unknown';
}
