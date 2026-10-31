import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The blob store of the originals (FR-004, FR-033): a file arrives as a stream, is hashed and counted while it is written
 * to a temporary name, and only then is it given its final name, which is its content hash. Nothing is read whole into
 * memory and the size cap is enforced on the stream, not on a header the sender controls (AGENTS.md). The final name is
 * `blobs/<sha256[0:2]>/<sha256>` relative to a configured root, never a host path and never a name taken from the sender.
 */

/** The stream was longer than the cap; the caller turns this into `too_large` (a skipped file, or HTTP 413). */
export class BlobTooLargeError extends Error {
  maxBytes: number;

  constructor(maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes`);
    this.name = 'BlobTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** A file that has been written and hashed but not yet given its final name. */
export type StagedBlob = {
  sha256: string;
  sizeBytes: number;
  tempPath: string;
};

/** The key of an original: relative to the blob root, derived from the hash only. */
export function blobKeyOf(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Writes `source` to a new temporary file under `<root>/tmp` while computing its sha256 and size. A stream over `maxBytes`
 * fails with `BlobTooLargeError` the moment it crosses the cap. On any failure the temporary file is removed: it is the
 * app's own scratch file, never a stored document.
 */
export async function stageStream(blobRoot: string, source: Readable, maxBytes: number): Promise<StagedBlob> {
  const tempDir = path.join(blobRoot, 'tmp');
  await mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, randomBytes(16).toString('hex'));
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        callback(new BlobTooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(tempPath, { flags: 'wx', mode: 0o640 }));
  } catch (error) {
    await discardStaged(tempPath);
    throw error;
  }
  return { sha256: hash.digest('hex'), sizeBytes, tempPath };
}

/**
 * Gives a staged file its final name by a hard link, so an original that is already stored is never overwritten, and
 * removes the temporary name. Returns the key. Two files with the same hash are the same content, so keeping the first is
 * correct.
 */
export async function commitStaged(blobRoot: string, staged: StagedBlob): Promise<string> {
  const key = blobKeyOf(staged.sha256);
  const finalPath = path.join(blobRoot, key);
  await mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await link(staged.tempPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await discardStaged(staged.tempPath);
  return key;
}

/** The key of a page preview: relative to the blob root, derived from the document's hash and the page number only. */
export function pageBlobKey(sha256: string, pageNo: number): string {
  return `pages/${sha256}/page-${pageNo}.png`;
}

/**
 * Stores bytes under a key unless the key is taken: a second attempt at the same step writes the same preview, and an
 * existing file is never overwritten (data is append-only, AGENTS.md). Returns true when the file was written.
 */
export async function writeBlobIfAbsent(blobRoot: string, key: string, data: Buffer): Promise<boolean> {
  const finalPath = path.join(blobRoot, key);
  await mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await writeFile(finalPath, data, { flag: 'wx', mode: 0o640 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Removes the temporary file of a staged blob that will not be kept (a duplicate, or a failure); a missing file is fine. */
export async function discardStaged(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
