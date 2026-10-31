import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type { Readable } from 'node:stream';
import type pg from 'pg';
import type { ClassesFile } from '../config/types.ts';
import { documentBySha256, insertDocument } from '../db/queries.ts';
import type { Logger } from '../shared/logger.ts';
import { commitStaged, discardStaged, stageStream } from './store.ts';

/**
 * Taking a file in, the part that the folder read and the upload share (FR-001 to FR-006): stream it into the blob store,
 * look its hash up, and either report it as a duplicate of a known document or give it a class, a final name and a
 * `RECEIVED` row. Identity is the content hash; the name and the path are descriptions only (FR-002).
 */

/** What intake needs. */
export type IntakeDeps = {
  pool: pg.Pool;
  /** The inbox folder (read-only mount); also where the generator's manifest is. */
  inboxDir: string;
  /** The root of the blob store; keys are relative to it. */
  blobRoot: string;
  /** The most bytes a file may have, from `intake.upload_max_bytes`. */
  maxBytes: number;
  classes: ClassesFile;
  logger: Logger;
};

/** The two classes the intake rule assigns (FR-006). Their egress rules live in `config/classes.json` (FR-007). */
const syntheticClass = 'synthetic';
const unverifiedClass = 'unverified';

/** Stops the application when the closed list of classes lacks one of the two the intake rule can assign. */
export function assertIntakeClasses(classes: ClassesFile): void {
  for (const name of [syntheticClass, unverifiedClass]) {
    if (!classes.classes.some((entry) => entry.name === name)) {
      throw new Error(`The intake rule assigns the class "${name}", but config/classes.json does not declare it`);
    }
  }
}

/** The largest generator manifest read: the real one is a few kilobytes. */
const maxManifestBytes = 1_048_576;

/**
 * The hashes the fixtures generator listed in `<inbox>/manifest.json`. A missing manifest means no synthetic documents; one
 * that cannot be read or does not look like the generator's is reported and treated the same, so a broken file can only
 * make documents `unverified`, never `synthetic`.
 */
export async function generatorHashes(inboxDir: string, logger: Logger): Promise<Set<string>> {
  const file = path.join(inboxDir, 'manifest.json');
  const hashes = new Set<string>();
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxManifestBytes) {
      logger.warn({ file: 'manifest.json' }, 'The generator manifest is not a regular file under 1 MiB; no document is synthetic.');
      return hashes;
    }
    const handle = await open(file, 'r');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(handle, 'utf8'));
    } finally {
      await handle.close();
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const hash = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['sha256'] : undefined;
        if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) {
          hashes.add(hash);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ cause: error instanceof Error ? error.message : String(error) }, 'The generator manifest could not be read; no document is synthetic.');
    }
  }
  return hashes;
}

/** The one declared class rule (FR-006): `synthetic` only when the hash is in the generator manifest, else `unverified`. */
export function classOf(sha256: string, generated: Set<string>): string {
  return generated.has(sha256) ? syntheticClass : unverifiedClass;
}

/** What taking a file in came to. */
export type TakeOutcome =
  | { kind: 'taken'; number: number; sha256: string; documentClass: string }
  | { kind: 'duplicate'; originalNumber: number; sha256: string };

/** The descriptions kept with a new document; neither decides identity or processing. */
export type TakeMeta = {
  originalName: string | null;
  /** Relative to the inbox for folder documents, null for uploads. */
  originalPath: string | null;
};

/**
 * Streams `source` into the blob store and takes the file in. A known hash is a duplicate: the staged copy is dropped,
 * nothing is stored and the documents count does not change (FR-003). A new hash gets its final blob name and a `RECEIVED`
 * row. If another request inserted the same hash between the lookup and the insert, the database refuses the second row
 * and this reports the duplicate too.
 */
export async function takeBlob(deps: IntakeDeps, source: Readable, meta: TakeMeta, generated: Set<string>): Promise<TakeOutcome> {
  const staged = await stageStream(deps.blobRoot, source, deps.maxBytes);
  const known = await documentBySha256(deps.pool, staged.sha256);
  if (known !== null) {
    await discardStaged(staged.tempPath);
    return { kind: 'duplicate', originalNumber: known.id, sha256: staged.sha256 };
  }
  const blobKey = await commitStaged(deps.blobRoot, staged);
  const documentClass = classOf(staged.sha256, generated);
  const number = await insertDocument(deps.pool, {
    sha256: staged.sha256,
    originalName: meta.originalName,
    originalPath: meta.originalPath,
    sizeBytes: staged.sizeBytes,
    documentClass,
    blobKey,
  });
  if (number === null) {
    const original = await documentBySha256(deps.pool, staged.sha256);
    if (original === null) {
      throw new Error('The database refused a new document for a hash it does not know');
    }
    return { kind: 'duplicate', originalNumber: original.id, sha256: staged.sha256 };
  }
  return { kind: 'taken', number, sha256: staged.sha256, documentClass };
}
