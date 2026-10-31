import { constants, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { detectMime } from './tools/detect.ts';
import { previewImage, readJpegSize, readPngSize } from './tools/image.ts';
import { isPasswordFailure, pdfImageDpi, pdfinfo, pdfPageSizes, pdfPageText, popplerVersion, renderForOcr, renderPreview } from './tools/poppler.ts';
import type { PageSize } from './tools/poppler.ts';
import { renderSvg, rsvgVersion } from './tools/rsvg.ts';
import { maxOutputBytes, ToolError } from './tools/run.ts';
import type { ToolBudget } from './tools/run.ts';
import { convertToPdf, officeExtensions, sofficeVersion } from './tools/soffice.ts';
import { ocrImage, tesseractVersion } from './tools/tesseract.ts';

/**
 * One job of the parser (C8): the original at `<jobs>/in/<jobId>/input` is turned into the page files and the manifest
 * of contracts/parser.md in `<jobs>/out/<jobId>/`. This module is the one-shot program that every job runs as a fresh
 * child process of the server; it reads the original only through the tools of `tools/` and writes nothing outside the
 * job's own output and scratch folders. It decides which reason a failure is, but never what a document means: that is
 * the pipeline's work.
 */

/** The numbers the parser works to and the bounds each must lie in (contracts/parser.md). */
const limitBounds = {
  convertTimeoutS: [1, 3600],
  renderTimeoutSPerPage: [1, 600],
  ocrTimeoutSPerPage: [1, 600],
  pageCap: [1, 50],
  ocrDpi: [72, 600],
  renderWidthPx: [100, 4000],
  pngMaxSidePx: [100, 4000],
  pngMaxBytes: [1024, 67_108_864],
  textMaxBytes: [1024, 16_777_216],
  toolMemoryMb: [64, 2048],
  scannedPageMaxChars: [0, 100_000],
  ocrLowConfidence: [0, 100],
} as const;

/** The limits of one job: the parser's rows of the thresholds file, read once when the service starts. */
export type Limits = { [Name in keyof typeof limitBounds]: number };

/** The names of the limits, in the order of `limitBounds`. */
const limitNames = Object.keys(limitBounds) as (keyof Limits)[];

/** The row of the thresholds file each limit comes from. */
const limitKeys: Record<keyof Limits, string> = {
  convertTimeoutS: 'parser.convert_timeout_s',
  renderTimeoutSPerPage: 'parser.render_timeout_s_per_page',
  ocrTimeoutSPerPage: 'parser.ocr_timeout_s_per_page',
  pageCap: 'parser.page_cap',
  ocrDpi: 'parser.ocr_dpi',
  renderWidthPx: 'parser.render_width_px',
  pngMaxSidePx: 'parser.png_max_side_px',
  pngMaxBytes: 'parser.png_max_bytes',
  textMaxBytes: 'parser.text_max_bytes',
  toolMemoryMb: 'parser.tool_memory_mb',
  scannedPageMaxChars: 'quality.scanned_page_max_chars',
  ocrLowConfidence: 'quality.ocr_low_confidence',
};

/** True for an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is an integer inside the bounds of the limit `name`. */
function withinBounds(name: keyof Limits, value: unknown): value is number {
  const [low, high] = limitBounds[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
}

/**
 * Checks a set of limits and returns them typed, or null: every limit present as an integer inside its bounds and no
 * other key. The server hands the child its limits on standard input, and the child checks them again, so a job never
 * runs on a number outside the bounds, whichever way it got there.
 */
export function parseLimits(value: unknown): Limits | null {
  if (!isRecord(value) || Object.keys(value).length !== limitNames.length) {
    return null;
  }
  const limits: Record<string, number> = {};
  for (const name of limitNames) {
    const candidate = value[name];
    if (!withinBounds(name, candidate)) {
      return null;
    }
    limits[name] = candidate;
  }
  return limits as Limits;
}

/** The most the thresholds file may be: the real one is a few kilobytes. */
const maxThresholdsBytes = 1_048_576;

/**
 * Reads the parser's limits from the thresholds file, which compose mounts read-only from `config/`. The service calls it
 * once when it starts, as the app does with the same file (C13), so a change of a threshold takes effect when both are
 * restarted. A row that is missing or outside its bounds stops the start and names the row: a parser that ran on a
 * guessed number would disagree with the thresholds the app stores with the job.
 */
export async function loadLimits(file: string): Promise<Limits> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxThresholdsBytes) {
    throw new Error(`The thresholds file ${file} is not a regular file of at most ${maxThresholdsBytes} bytes`);
  }
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const values = isRecord(parsed) ? parsed['values'] : undefined;
  const limits: Record<string, number> = {};
  for (const name of limitNames) {
    const key = limitKeys[name];
    const row = isRecord(values) ? values[key] : undefined;
    const value = isRecord(row) ? row['value'] : undefined;
    if (!withinBounds(name, value)) {
      const [low, high] = limitBounds[name];
      throw new Error(`The threshold ${key} must be an integer from ${low} to ${high}, found ${JSON.stringify(value) ?? 'nothing'}`);
    }
    limits[name] = value;
  }
  return limits as Limits;
}

/** The folders of one job. */
export type JobPaths = {
  jobId: string;
  inDir: string;
  outDir: string;
  workDir: string;
};

/** The reasons the parser itself ends a job with (the other two parser-side reasons are the pipeline's, from the manifest). */
export type ParserReason = 'TOO_LARGE' | 'CORRUPT' | 'ENCRYPTED' | 'UNSUPPORTED_FORMAT';

/** What a job ended with: the manifest was written, or a reason with its parameters. */
export type ParseOutcome = { ok: true } | { ok: false; code: ParserReason; params: Record<string, string | number> };

/** A job that ends with a reason; thrown from anywhere below and turned into a `ParseOutcome` by `parse`. */
export class ReasonError extends Error {
  code: ParserReason;
  params: Record<string, string | number>;

  constructor(code: ParserReason, params: Record<string, string | number> = {}) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = 'ReasonError';
    this.code = code;
    this.params = params;
  }
}

/** A page as the manifest describes it (contracts/parser-manifest.schema.json). */
type PageEntry = {
  n: number;
  source: 'text_layer' | 'ocr';
  engine: string;
  engineVersion: string;
  dpi: number | null;
  widthPx: number;
  heightPx: number;
  ocrWordsTotal: number | null;
  ocrWordsLow: number | null;
  timingsMs: { render: number; text: number; ocr: number };
};

/** Everything one job shares between its steps. */
type Context = {
  paths: JobPaths;
  limits: Limits;
  input: string;
  quick: ToolBudget;
  render: ToolBudget;
  ocr: ToolBudget;
  convert: ToolBudget;
  pages: PageEntry[];
  limitsHit: string[];
  timings: { detect: number; convert: number; pdfinfo: number };
};

/** Milliseconds since `start`, rounded, for the manifest's timings. */
function since(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * Names the reason for a tool that failed. A tool over its time or memory is `TOO_LARGE` with the limit it hit, one that
 * could not read the file is `CORRUPT` naming the tool (AGENTS.md, C6). Which limit a timeout belongs to follows from the
 * tool: LibreOffice has the conversion limit, Tesseract the OCR limit, the rest the per-page limit.
 */
function reasonOfTool(error: ToolError, limits: Limits): ReasonError {
  const seconds = Math.ceil(error.elapsedMs / 1000);
  if (error.kind === 'exit') {
    return new ReasonError('CORRUPT', { tool: error.tool });
  }
  if (error.kind === 'memory') {
    return new ReasonError('TOO_LARGE', { limit: 'tool_memory_mb', actual: limits.toolMemoryMb, max: limits.toolMemoryMb });
  }
  if (error.kind === 'output') {
    return new ReasonError('TOO_LARGE', { limit: 'tool_output_bytes', actual: maxOutputBytes + 1, max: maxOutputBytes });
  }
  if (error.tool === 'soffice') {
    return new ReasonError('TOO_LARGE', { limit: 'convert_timeout_s', actual: seconds, max: limits.convertTimeoutS });
  }
  if (error.tool === 'tesseract') {
    return new ReasonError('TOO_LARGE', { limit: 'ocr_timeout_s_per_page', actual: seconds, max: limits.ocrTimeoutSPerPage });
  }
  return new ReasonError('TOO_LARGE', { limit: 'render_timeout_s_per_page', actual: seconds, max: limits.renderTimeoutSPerPage });
}

/** Checks the size of an image against the side limit and refuses it as `TOO_LARGE` when a side is longer. */
function assertSide(width: number, height: number, limits: Limits): void {
  const side = Math.max(width, height);
  if (side > limits.pngMaxSidePx) {
    throw new ReasonError('TOO_LARGE', { limit: 'png_max_side_px', actual: side, max: limits.pngMaxSidePx });
  }
}

/**
 * Puts one page into the output folder: the preview PNG (its signature and size read from the header and held to the
 * limits before it is copied), the text and, for OCR pages, the word table. Files are created with `wx`/`COPYFILE_EXCL`,
 * so nothing that is already there is overwritten. Returns the preview's pixel size for the manifest.
 */
async function writePage(context: Context, n: number, preview: string, text: string, tsv: string | null): Promise<{ widthPx: number; heightPx: number }> {
  const size = await readPngSize(preview);
  if (size === null) {
    throw new ReasonError('CORRUPT', { tool: 'render' });
  }
  assertSide(size.width, size.height, context.limits);
  const bytes = (await stat(preview)).size;
  if (bytes > context.limits.pngMaxBytes) {
    throw new ReasonError('TOO_LARGE', { limit: 'png_max_bytes', actual: bytes, max: context.limits.pngMaxBytes });
  }
  for (const body of [text, tsv ?? '']) {
    const length = Buffer.byteLength(body, 'utf8');
    if (length > context.limits.textMaxBytes) {
      throw new ReasonError('TOO_LARGE', { limit: 'text_max_bytes', actual: length, max: context.limits.textMaxBytes });
    }
  }
  await copyFile(preview, path.join(context.paths.outDir, `page-${n}.png`), constants.COPYFILE_EXCL);
  await writeFile(path.join(context.paths.outDir, `page-${n}.txt`), text, { encoding: 'utf8', flag: 'wx' });
  if (tsv !== null) {
    await writeFile(path.join(context.paths.outDir, `page-${n}.tsv`), tsv, { encoding: 'utf8', flag: 'wx' });
  }
  return { widthPx: size.width, heightPx: size.height };
}

/**
 * The highest resolution at which a page may be read by OCR: the configured one, lowered when the page is so large that the
 * rendered image would pass the side limit, and never below 72 (the manifest's floor). A page that would need less is too
 * large to read at all and the job ends `TOO_LARGE`. The caller lowers it further to the resolution of a scanned image.
 */
function ocrDpiFor(size: PageSize, limits: Limits): number {
  const sidePt = Math.max(size.widthPt, size.heightPt);
  const dpi = Math.min(limits.ocrDpi, Math.floor((limits.pngMaxSidePx * 72) / sidePt));
  if (dpi < 72) {
    throw new ReasonError('TOO_LARGE', { limit: 'page_size_pt', actual: Math.ceil(sidePt), max: Math.floor(limits.pngMaxSidePx) });
  }
  return dpi;
}

/**
 * Reads every page of a PDF: its text layer when it has one, OCR when the layer has fewer than `scannedPageMaxChars`
 * characters other than whitespace (the scanned-page rule of R8), and a preview at the preview width for each. Before any
 * page is rendered `pdfinfo` has to accept the file: readable, not encrypted, not more pages than the cap, every page of a
 * size that can be rendered.
 */
async function readPdf(pdf: string, context: Context): Promise<void> {
  const { limits, paths } = context;
  const started = performance.now();
  let pages: number;
  try {
    const info = await pdfinfo(pdf, context.quick);
    if (info.encrypted) {
      throw new ReasonError('ENCRYPTED');
    }
    pages = info.pages;
  } catch (error) {
    throw isPasswordFailure(error) ? new ReasonError('ENCRYPTED') : error;
  }
  if (pages === 0) {
    throw new ReasonError('CORRUPT', { tool: 'pdfinfo' });
  }
  if (pages > limits.pageCap) {
    throw new ReasonError('TOO_LARGE', { limit: 'page_cap', actual: pages, max: limits.pageCap });
  }
  const sizes = await pdfPageSizes(pdf, pages, context.quick);
  context.timings.pdfinfo = since(started);
  const poppler = await popplerVersion(context.quick);
  let tesseract: string | null = null;
  for (let n = 1; n <= pages; n += 1) {
    const size = sizes[n - 1];
    const base = path.join(paths.workDir, `page-${n}`);
    const textStart = performance.now();
    let text = await pdfPageText(pdf, n, context.quick);
    const textMs = since(textStart);
    const renderStart = performance.now();
    const preview = await renderPreview(pdf, n, `${base}-preview`, limits.renderWidthPx, context.render);
    let renderMs = since(renderStart);
    let entry: PageEntry;
    let tsv: string | null = null;
    if (text.replace(/\s/gu, '').length >= limits.scannedPageMaxChars) {
      entry = { n, source: 'text_layer', engine: 'pdftotext', engineVersion: poppler, dpi: null, widthPx: 0, heightPx: 0, ocrWordsTotal: null, ocrWordsLow: null, timingsMs: { render: renderMs, text: textMs, ocr: 0 } };
    } else {
      const pageDpi = size === undefined ? limits.ocrDpi : ocrDpiFor(size, limits);
      if (pageDpi < limits.ocrDpi) {
        context.limitsHit.push('ocr_dpi_reduced');
      }
      const imageDpi = await pdfImageDpi(pdf, n, context.quick);
      const dpi = imageDpi === null ? pageDpi : Math.max(72, Math.min(pageDpi, imageDpi));
      const ocrRenderStart = performance.now();
      const raster = await renderForOcr(pdf, n, `${base}-ocr`, dpi, context.render);
      renderMs += since(ocrRenderStart);
      const ocrStart = performance.now();
      const result = await ocrImage(raster, `${base}-ocr`, limits.ocrLowConfidence, context.ocr);
      const ocrMs = since(ocrStart);
      tesseract ??= await tesseractVersion(context.quick);
      text = result.text;
      tsv = result.tsv;
      entry = { n, source: 'ocr', engine: 'tesseract', engineVersion: tesseract, dpi, widthPx: 0, heightPx: 0, ocrWordsTotal: result.wordsTotal, ocrWordsLow: result.wordsLow, timingsMs: { render: renderMs, text: textMs, ocr: ocrMs } };
    }
    const written = await writePage(context, n, preview, text, tsv);
    context.pages.push({ ...entry, widthPx: written.widthPx, heightPx: written.heightPx });
  }
}

/**
 * Reads one raster image, a PNG or a JPEG: the size from the header against the side limit before any decode, a preview
 * through ImageMagick, and OCR on the original raster (R8). The image is one page; its resolution is not known.
 */
async function readImage(format: 'png' | 'jpeg', context: Context): Promise<void> {
  const { limits, paths, input } = context;
  const size = format === 'png' ? await readPngSize(input) : await readJpegSize(input);
  if (size === null) {
    throw new ReasonError('CORRUPT', { tool: 'image' });
  }
  assertSide(size.width, size.height, limits);
  const base = path.join(paths.workDir, 'page-1');
  const renderStart = performance.now();
  await previewImage(input, format, `${base}-preview.png`, limits.renderWidthPx, context.render);
  const renderMs = since(renderStart);
  const ocrStart = performance.now();
  const result = await ocrImage(input, `${base}-ocr`, limits.ocrLowConfidence, context.ocr);
  const ocrMs = since(ocrStart);
  const written = await writePage(context, 1, `${base}-preview.png`, result.text, result.tsv);
  context.pages.push({ n: 1, source: 'ocr', engine: 'tesseract', engineVersion: await tesseractVersion(context.quick), dpi: null, ...written, ocrWordsTotal: result.wordsTotal, ocrWordsLow: result.wordsLow, timingsMs: { render: renderMs, text: 0, ocr: ocrMs } });
}

/** Reads an SVG: rendered to a PNG at the preview width, held to the same caps, then read by OCR like any image. */
async function readSvg(context: Context): Promise<string> {
  const { limits, paths, input } = context;
  const base = path.join(paths.workDir, 'page-1');
  const convertStart = performance.now();
  await renderSvg(input, `${base}-preview.png`, limits.renderWidthPx, context.convert);
  context.timings.convert = since(convertStart);
  const size = await readPngSize(`${base}-preview.png`);
  if (size === null) {
    throw new ReasonError('CORRUPT', { tool: 'rsvg-convert' });
  }
  assertSide(size.width, size.height, limits);
  const ocrStart = performance.now();
  const result = await ocrImage(`${base}-preview.png`, `${base}-ocr`, limits.ocrLowConfidence, context.ocr);
  const ocrMs = since(ocrStart);
  const written = await writePage(context, 1, `${base}-preview.png`, result.text, result.tsv);
  context.pages.push({ n: 1, source: 'ocr', engine: 'tesseract', engineVersion: await tesseractVersion(context.quick), dpi: null, ...written, ocrWordsTotal: result.wordsTotal, ocrWordsLow: result.wordsLow, timingsMs: { render: context.timings.convert, text: 0, ocr: ocrMs } });
  return `rsvg-convert ${await rsvgVersion(context.quick)}`;
}

/**
 * Runs one job. The type is detected from the content; a PDF, an image, an SVG or an office document is read, anything
 * else is `UNSUPPORTED_FORMAT` with the type found. The manifest is written last, so an output folder that has one is
 * complete. A reason is returned as an outcome; any other failure is an `Error` that the caller reports as an
 * internal error. The job's scratch folder lives on tmpfs and is removed at the end whichever way the job ended.
 */
export async function parse(paths: JobPaths, limits: Limits): Promise<ParseOutcome> {
  const started = performance.now();
  const budget = (timeoutS: number): ToolBudget => ({ timeoutS, memoryMb: limits.toolMemoryMb });
  const context: Context = {
    paths,
    limits,
    input: path.join(paths.inDir, 'input'),
    quick: budget(limits.renderTimeoutSPerPage),
    render: budget(limits.renderTimeoutSPerPage),
    ocr: budget(limits.ocrTimeoutSPerPage),
    convert: budget(limits.convertTimeoutS),
    pages: [],
    limitsHit: [],
    timings: { detect: 0, convert: 0, pdfinfo: 0 },
  };
  try {
    await mkdir(paths.workDir, { recursive: true });
    const detectStart = performance.now();
    const mime = await detectMime(context.input, context.quick);
    context.timings.detect = since(detectStart);
    let converter: string | null = null;
    const extension = officeExtensions[mime];
    if (mime === 'application/pdf') {
      await readPdf(context.input, context);
    } else if (extension !== undefined) {
      const convertStart = performance.now();
      const pdf = await convertToPdf(context.input, extension, paths.workDir, context.convert);
      context.timings.convert = since(convertStart);
      if (pdf === null) {
        throw new ReasonError('CORRUPT', { tool: 'soffice' });
      }
      converter = `soffice ${await sofficeVersion(paths.workDir, context.quick)}`;
      await readPdf(pdf, context);
    } else if (mime === 'image/png') {
      await readImage('png', context);
    } else if (mime === 'image/jpeg') {
      await readImage('jpeg', context);
    } else if (mime === 'image/svg+xml') {
      converter = await readSvg(context);
    } else {
      throw new ReasonError('UNSUPPORTED_FORMAT', { mime });
    }
    const manifest = {
      version: 1,
      jobId: paths.jobId,
      detectedMime: mime,
      converter,
      pageCount: context.pages.length,
      pages: context.pages,
      timingsMs: { ...context.timings, total: since(started) },
      limitsHit: [...new Set(context.limitsHit)],
    };
    await writeFile(path.join(paths.outDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (error) {
    if (error instanceof ReasonError) {
      return { ok: false, code: error.code, params: error.params };
    }
    if (error instanceof ToolError) {
      const reason = reasonOfTool(error, limits);
      return { ok: false, code: reason.code, params: reason.params };
    }
    throw error;
  } finally {
    await rm(paths.workDir, { recursive: true, force: true });
  }
}

/** Reads all of standard input up to a small cap: the request of one job is a few hundred bytes. */
async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 8192) {
      throw new Error('The job request is larger than 8 KiB');
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * The entry point of a job's child process: reads `{jobId, limits}` from standard input, runs the job and prints the
 * outcome as one JSON line. The folders come from the environment so tests can point them elsewhere; in the container
 * they are `/jobs` and `/tmp`.
 */
async function main(): Promise<void> {
  const request = await readRequest();
  const jobId = isRecord(request) ? request['jobId'] : undefined;
  const limits = isRecord(request) ? parseLimits(request['limits']) : null;
  if (typeof jobId !== 'string' || !/^[a-z0-9]{32}$/.test(jobId) || limits === null) {
    throw new Error('The job request is not {jobId, limits}');
  }
  const jobs = process.env['PARSER_JOBS_DIR'] ?? '/jobs';
  const scratch = process.env['PARSER_WORK_DIR'] ?? '/tmp';
  const outcome = await parse({ jobId, inDir: path.join(jobs, 'in', jobId), outDir: path.join(jobs, 'out', jobId), workDir: path.join(scratch, jobId) }, limits);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
