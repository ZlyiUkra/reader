import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path/posix';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { ParserManifest, ParserManifestPage } from '../config/types.ts';

/**
 * The only code that reads what the parser wrote (FR-014, constitution VII, acceptance check 7). The parser is the
 * untrusted side: whatever a hostile document made it write, it must not reach the app as a path, a link, a size or a
 * file that is more than it says. So the output folder is read under fixed rules: names that are built here and never
 * taken from the manifest, only regular files with one link, a size cap checked before a byte is read, a file opened
 * without following a link and shown to be the file that was checked, and a manifest validated against its schema
 * before any page file is touched. A violation stops the read at once with an `UnsafeOutputError`, and nothing after it
 * is opened.
 */

/** The caps the read holds the output to; the pipeline passes the rows of the thresholds file. */
export type SafeReadLimits = {
  manifestMaxBytes: number;
  pngMaxBytes: number;
  textMaxBytes: number;
  pngMaxSidePx: number;
};

/**
 * What a hostile or broken output looks like to the caller: the job is failed with `INTERNAL_ERROR` and the cause
 * `unsafe_output` (contracts/parser.md). The message names the violated rule and the file, never any content.
 */
export class UnsafeOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsafeOutputError';
  }
}

/** One page as the pipeline stores it: the preview image, the text, the OCR table of an OCR page, and the manifest's entry. */
export type ParsedPage = {
  n: number;
  png: Buffer;
  text: string;
  tsv: string | null;
  entry: ParserManifestPage;
};

/** The whole output of one job once it has passed every check. */
export type ParserOutput = {
  manifest: ParserManifest;
  pages: ParsedPage[];
};

/** The mode of a job's output folder: group-writable and setgid, so the parser (group 10001) can write into a folder the app made. */
const outDirMode = 0o2775;

/** A job id as the app mints it; the same pattern the parser's request check uses. */
const jobIdPattern = /^[a-z0-9]{32}$/;

/** The eight bytes every PNG starts with. */
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Makes sure `<outRoot>/<jobId>/` exists as a real directory and is empty, before the job is dispatched (C8): the one
 * place in the system where the app deletes anything, and only inside the folder of the job in flight. Entries are
 * removed without following links. A folder that is a link or a file in the folder's place is refused.
 */
export async function prepareOutDir(outRoot: string, jobId: string): Promise<string> {
  if (!jobIdPattern.test(jobId)) {
    throw new UnsafeOutputError('The job id is not 32 lower-case letters and digits');
  }
  await fs.mkdir(outRoot, { recursive: true, mode: outDirMode });
  const target = path.join(outRoot, jobId);
  await fs.mkdir(target, { recursive: true, mode: outDirMode });
  const info = await fs.lstat(target);
  if (!info.isDirectory()) {
    throw new UnsafeOutputError('The output folder of the job is not a directory');
  }
  await fs.chmod(target, outDirMode);
  for (const entry of await fs.readdir(target)) {
    await fs.rm(path.join(target, entry), { recursive: true, force: true });
  }
  return target;
}

/**
 * Reads one regular file under the rules above. `lstat` first (a link, a directory or a device is not a regular file; a
 * second hard link means the name is shared with something else; a size over the cap is refused without a read), then
 * `open` with `O_NOFOLLOW`, then `fstat` of the open file to see it is the same file by device and inode and has not
 * grown, and only then the read, into a buffer of exactly the checked size.
 */
async function readRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  const name = path.basename(file);
  let before: Stats;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    throw new UnsafeOutputError(`${name} is missing from the output`, { cause: error });
  }
  if (!before.isFile()) {
    throw new UnsafeOutputError(`${name} is not a regular file`);
  }
  if (before.nlink !== 1) {
    throw new UnsafeOutputError(`${name} has more than one hard link`);
  }
  if (before.size > maxBytes) {
    throw new UnsafeOutputError(`${name} is larger than its limit of ${maxBytes} bytes`);
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new UnsafeOutputError(`${name} could not be opened without following a link`, { cause: error });
  }
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size) {
      throw new UnsafeOutputError(`${name} changed between the check and the read`);
    }
    const buffer = Buffer.alloc(after.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        throw new UnsafeOutputError(`${name} is shorter than it was when it was checked`);
      }
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Decodes bytes as UTF-8 and refuses invalid sequences instead of replacing them. */
function decodeUtf8(bytes: Buffer, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UnsafeOutputError(`${name} is not valid UTF-8`, { cause: error });
  }
}

/**
 * Checks a page image: the PNG signature, an IHDR chunk straight after it, and the dimensions in it under the side limit
 * and equal to what the manifest says for the page.
 */
function checkPng(png: Buffer, entry: ParserManifestPage, limits: SafeReadLimits, name: string): void {
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature) || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new UnsafeOutputError(`${name} is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width > limits.pngMaxSidePx || height > limits.pngMaxSidePx) {
    throw new UnsafeOutputError(`${name} is ${width} x ${height} pixels, over the side limit of ${limits.pngMaxSidePx}`);
  }
  if (width !== entry.widthPx || height !== entry.heightPx) {
    throw new UnsafeOutputError(`${name} is ${width} x ${height} pixels and the manifest says ${entry.widthPx} x ${entry.heightPx}`);
  }
}

/**
 * Reads and checks the whole output of a finished job. The manifest comes first and must pass its schema, and its job id
 * and page list must be what the call expects, before any page file is opened. Page file names are built from the page
 * number the loop counts, never from a string in the manifest. An OCR page must have its word table; a text-layer page
 * has none and none is read.
 */
export async function readParserOutput(outDir: string, jobId: string, validate: ValidateFunction<ParserManifest>, limits: SafeReadLimits): Promise<ParserOutput> {
  const manifestBytes = await readRegularFile(path.join(outDir, 'manifest.json'), limits.manifestMaxBytes);
  let data: unknown;
  try {
    data = JSON.parse(decodeUtf8(manifestBytes, 'manifest.json')) as unknown;
  } catch (error) {
    throw error instanceof UnsafeOutputError ? error : new UnsafeOutputError('manifest.json is not JSON', { cause: error });
  }
  if (!validate(data)) {
    const first = validate.errors?.[0];
    throw new UnsafeOutputError(`manifest.json does not match its contract: ${first?.instancePath ?? ''} ${first?.message ?? ''}`.trim());
  }
  const manifest = data;
  if (manifest.jobId !== jobId) {
    throw new UnsafeOutputError('manifest.json belongs to another job');
  }
  if (manifest.pages.length !== manifest.pageCount || manifest.pages.some((entry, index) => entry.n !== index + 1)) {
    throw new UnsafeOutputError('manifest.json lists pages that do not run from 1 to the page count');
  }
  const pages: ParsedPage[] = [];
  for (const entry of manifest.pages) {
    const base = path.join(outDir, `page-${entry.n}`);
    const png = await readRegularFile(`${base}.png`, limits.pngMaxBytes);
    checkPng(png, entry, limits, `page-${entry.n}.png`);
    const text = decodeUtf8(await readRegularFile(`${base}.txt`, limits.textMaxBytes), `page-${entry.n}.txt`);
    const tsv = entry.source === 'ocr' ? decodeUtf8(await readRegularFile(`${base}.tsv`, limits.textMaxBytes), `page-${entry.n}.tsv`) : null;
    pages.push({ n: entry.n, png, text, tsv, entry });
  }
  return { manifest, pages };
}
