import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path/posix';
import { BlobTooLargeError } from './store.ts';
import { generatorHashes, takeBlob } from './take.ts';
import type { IntakeDeps } from './take.ts';

/**
 * The inbox folder (FR-001, FR-003, FR-005): a list that does not hash, and a read that does. The folder is a read-only
 * mount and holds whatever the owner put there, so every entry is opened without following links and measured before it is
 * read. Only regular files at the top level are considered; subfolders (the generator's `expected/` among them), dot-files
 * and the generator's manifest are not documents.
 */

/** One file of the listing. */
export type InboxFile = {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
};

/** `GET /inbox` (contracts/api.md): the folder as configured and its top-level regular files, without hashes. */
export type InboxListing = {
  path: string;
  files: InboxFile[];
};

/** The generator's own file at the top level; the expected-value files sit in the `expected/` subfolder. */
const generatorManifestName = 'manifest.json';

/** True for an entry that may be a document: not a dot-file, not the manifest, not a subfolder. */
function isCandidate(entry: Dirent): boolean {
  return !entry.name.startsWith('.') && entry.name !== generatorManifestName && !entry.isDirectory();
}

/** The candidates of the folder in name order, so repeated reads take files in the same order. */
async function candidates(inboxDir: string): Promise<Dirent[]> {
  const entries = await readdir(inboxDir, { withFileTypes: true });
  return entries.filter(isCandidate).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Lists the regular files at the top level of the inbox. Nothing is hashed or read. */
export async function listInbox(inboxDir: string): Promise<InboxListing> {
  const files: InboxFile[] = [];
  for (const entry of await candidates(inboxDir)) {
    if (!entry.isFile()) {
      continue;
    }
    try {
      const info = await lstat(path.join(inboxDir, entry.name));
      files.push({ name: entry.name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch {
      // The file went away between the listing and the stat; it is simply not listed.
    }
  }
  return { path: inboxDir, files };
}

/** Why a file of the folder was not taken in. */
export type SkipReason = 'not_regular' | 'too_large' | 'unreadable';

/** `POST /inbox/read` (contracts/api.md). */
export type InboxReadResult = {
  taken: Array<{ number: number; name: string; sha256: string; class: string }>;
  duplicates: Array<{ name: string; sha256: string; originalNumber: number; code: 'DUPLICATE' }>;
  skipped: Array<{ name: string; reason: SkipReason }>;
};

/**
 * Hashes every listed file and takes each one in: a new hash becomes a `RECEIVED` document, a known hash is reported as a
 * duplicate of its original and changes nothing. The files are read once, as streams. A file that is not regular (a link,
 * a device), too large or unreadable is reported under `skipped` and does not stop the others.
 */
export async function readInbox(deps: IntakeDeps): Promise<InboxReadResult> {
  const result: InboxReadResult = { taken: [], duplicates: [], skipped: [] };
  const generated = await generatorHashes(deps.inboxDir, deps.logger);
  for (const entry of await candidates(deps.inboxDir)) {
    const name = entry.name;
    if (!entry.isFile()) {
      result.skipped.push({ name, reason: 'not_regular' });
      continue;
    }
    let handle;
    try {
      handle = await open(path.join(deps.inboxDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      result.skipped.push({ name, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'not_regular' : 'unreadable' });
      continue;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        result.skipped.push({ name, reason: 'not_regular' });
        continue;
      }
      if (info.size > deps.maxBytes) {
        result.skipped.push({ name, reason: 'too_large' });
        continue;
      }
      const outcome = await takeBlob(deps, handle.createReadStream(), { originalName: name, originalPath: name }, generated);
      if (outcome.kind === 'taken') {
        result.taken.push({ number: outcome.number, name, sha256: outcome.sha256, class: outcome.documentClass });
      } else {
        result.duplicates.push({ name, sha256: outcome.sha256, originalNumber: outcome.originalNumber, code: 'DUPLICATE' });
      }
    } catch (error) {
      if (error instanceof BlobTooLargeError) {
        result.skipped.push({ name, reason: 'too_large' });
      } else if (isFileSystemError(error)) {
        deps.logger.warn({ code: (error as NodeJS.ErrnoException).code }, 'A file of the inbox could not be read; its name is in the result of the read.');
        result.skipped.push({ name, reason: 'unreadable' });
      } else {
        throw error;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return result;
}

/** True for an error raised by the file system (it carries a string `errno` code), as opposed to the database or a bug. */
function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? '');
}
