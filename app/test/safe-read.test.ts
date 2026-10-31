import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, symlink, truncate, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { test } from 'node:test';
import { createContractValidators } from '../src/config/ajv.ts';
import type { ParserManifest } from '../src/config/types.ts';
import { prepareOutDir, readParserOutput, UnsafeOutputError } from '../src/parser-client/safe-read.ts';

/**
 * The safe reader of the parser's output (FR-014, acceptance check 7). Each hostile output below is a folder the parser
 * could have been made to write: a link in place of a page image, a hard link to a file that is not the parser's, a
 * manifest that claims a gigabyte. The reader must fail the job on each, and the proof that nothing was read is that
 * `fs.open` was never called for the offending file: a refused file is refused by `lstat` before it is opened.
 */
const { parserManifest: validate } = await createContractValidators();
const limits = { manifestMaxBytes: 65_536, pngMaxBytes: 8_388_608, textMaxBytes: 1_048_576, pngMaxSidePx: 4000 };
const jobId = 'a'.repeat(32);

/** The smallest byte string the reader accepts as a PNG: the signature and a header chunk of the given size. */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13, 0);
  header.write('IHDR', 4, 'ascii');
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), header]);
}

/** A manifest of one text-layer page of 8 x 8 pixels, and one OCR page when `withOcr` is set. */
function manifestOf(withOcr: boolean): ParserManifest {
  const page = (n: number, source: 'text_layer' | 'ocr') => ({
    n,
    source,
    engine: source === 'ocr' ? 'tesseract' : 'pdftotext',
    engineVersion: '1',
    dpi: source === 'ocr' ? 300 : null,
    widthPx: 8,
    heightPx: 8,
    ocrWordsTotal: source === 'ocr' ? 3 : null,
    ocrWordsLow: source === 'ocr' ? 0 : null,
    timingsMs: { render: 1, text: 1, ocr: 0 },
  });
  const pages = withOcr ? [page(1, 'text_layer'), page(2, 'ocr')] : [page(1, 'text_layer')];
  return { version: 1, jobId, detectedMime: 'application/pdf', converter: null, pageCount: pages.length, pages, timingsMs: { detect: 1, convert: 0, pdfinfo: 1, total: 3 }, limitsHit: [] };
}

/** Writes a complete, valid output folder for `manifest` into a fresh temporary folder and returns its path. */
async function validJob(manifest: ParserManifest): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'safe-read-'));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const entry of manifest.pages) {
    await writeFile(path.join(dir, `page-${entry.n}.png`), pngOf(8, 8));
    await writeFile(path.join(dir, `page-${entry.n}.txt`), `Текст сторінки ${entry.n}`);
    if (entry.source === 'ocr') {
      await writeFile(path.join(dir, `page-${entry.n}.tsv`), 'level\tpage_num\n');
    }
  }
  return dir;
}

test('a complete output is read: the manifest, the images, the texts and the word table of an OCR page', async () => {
  const dir = await validJob(manifestOf(true));
  const output = await readParserOutput(dir, jobId, validate, limits);
  assert.equal(output.pages.length, 2);
  assert.equal(output.pages[0]?.text, 'Текст сторінки 1');
  assert.equal(output.pages[0]?.tsv, null);
  assert.equal(output.pages[1]?.tsv, 'level\tpage_num\n');
  assert.equal(output.pages[0]?.png.length, 33);
});

test('a symlinked page-1.png fails the job, and the file behind the link is never opened', async (t) => {
  const dir = await validJob(manifestOf(false));
  const secret = path.join(await mkdtemp(path.join(tmpdir(), 'secret-')), 'secret.txt');
  await writeFile(secret, 'not for the app');
  await fs.rm(path.join(dir, 'page-1.png'));
  await symlink(secret, path.join(dir, 'page-1.png'));
  const open = t.mock.method(fs, 'open');
  await assert.rejects(readParserOutput(dir, jobId, validate, limits), (error: unknown) => error instanceof UnsafeOutputError && /page-1\.png is not a regular file/.test(error.message) && !error.message.includes('not for the app'));
  assert.deepEqual(open.mock.calls.map((call) => path.basename(String(call.arguments[0]))), ['manifest.json']);
});

test('a hard link in the place of page-1.png fails the job without opening it', async (t) => {
  const dir = await validJob(manifestOf(false));
  const other = path.join(await mkdtemp(path.join(tmpdir(), 'other-')), 'other.png');
  await writeFile(other, pngOf(8, 8));
  await fs.rm(path.join(dir, 'page-1.png'));
  await link(other, path.join(dir, 'page-1.png'));
  const open = t.mock.method(fs, 'open');
  await assert.rejects(readParserOutput(dir, jobId, validate, limits), (error: unknown) => error instanceof UnsafeOutputError && /more than one hard link/.test(error.message));
  assert.deepEqual(open.mock.calls.map((call) => path.basename(String(call.arguments[0]))), ['manifest.json']);
});

test('a sparse manifest.json of 1 GB fails the job and is never opened', async (t) => {
  const dir = await validJob(manifestOf(false));
  await truncate(path.join(dir, 'manifest.json'), 1024 ** 3);
  const open = t.mock.method(fs, 'open');
  const started = performance.now();
  await assert.rejects(readParserOutput(dir, jobId, validate, limits), (error: unknown) => error instanceof UnsafeOutputError && /manifest\.json is larger than its limit/.test(error.message));
  assert.equal(open.mock.callCount(), 0);
  assert.ok(performance.now() - started < 1000, 'the refusal must not depend on the size of the file');
});

test('a page image that is not the size the manifest says, or is over the side limit, fails the job', async () => {
  for (const [width, height, pattern] of [
    [9, 8, /the manifest says 8 x 8/],
    [8, 4001, /over the side limit/],
  ] as const) {
    const dir = await validJob(manifestOf(false));
    await writeFile(path.join(dir, 'page-1.png'), pngOf(width, height));
    await assert.rejects(readParserOutput(dir, jobId, validate, limits), (error: unknown) => error instanceof UnsafeOutputError && pattern.test(error.message));
  }
});

test('a manifest of another job, a page list that skips a page and a text that is not UTF-8 fail the job', async () => {
  const other = await validJob({ ...manifestOf(false), jobId: 'b'.repeat(32) });
  await assert.rejects(readParserOutput(other, jobId, validate, limits), /belongs to another job/);
  const skipping = manifestOf(true);
  skipping.pages[1] = { ...skipping.pages[1]!, n: 3 };
  await assert.rejects(readParserOutput(await validJob(skipping), jobId, validate, limits), /do not run from 1/);
  const broken = await validJob(manifestOf(false));
  await writeFile(path.join(broken, 'page-1.txt'), Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(readParserOutput(broken, jobId, validate, limits), /not valid UTF-8/);
});

test('preparing the output folder empties it without following links and leaves what the links point to alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'out-root-'));
  const folder = path.join(root, jobId);
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'outside-')), 'keep.txt');
  await writeFile(outside, 'keep');
  await mkdir(path.join(folder, 'sub'), { recursive: true });
  await writeFile(path.join(folder, 'old.txt'), 'old');
  await writeFile(path.join(folder, 'sub', 'deep.txt'), 'deep');
  await symlink(outside, path.join(folder, 'link'));
  assert.equal(await prepareOutDir(root, jobId), folder);
  assert.deepEqual(await readdir(folder), []);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  await assert.rejects(prepareOutDir(root, '../escape'), UnsafeOutputError);
});
