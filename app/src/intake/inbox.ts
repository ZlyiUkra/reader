import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path/posix';
import { documentNumbersBySha256 } from '../db/queries.ts';
import { BlobTooLargeError } from './store.ts';
import { generatorHashes, takeBlob } from './take.ts';
import type { IntakeDeps } from './take.ts';

/**
 * The inbox folder (FR-001, FR-003, FR-005, FR-061): a list that says what each file is to the system, and a read that
 * takes the files in. The folder is a read-only mount and holds whatever the owner put there, so every entry is opened
 * without following links and measured before it is read. Only regular files at the top level are considered; subfolders
 * (the generator's `expected/` among them), dot-files and the generator's manifest are not documents. The list hashes a
 * file once, when it first shows it or when its size or modified time changes, and remembers the answer, so a poll of an
 * unchanged folder reads nothing; it only counts the hash and never opens the bytes as a document, which stays the
 * sandbox's work.
 */

/** What a row of the folder list says the file is: not read yet, a document already, or a file that cannot be taken. */
export type InboxState =
  | { kind: 'unread' }
  | { kind: 'document'; number: number }
  | { kind: 'skipped'; reason: 'too_large' | 'unreadable' };

/** One file of the listing. */
export type InboxFile = {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  state: InboxState;
};

/** What the listing keeps of a file it has looked at: the size and modified time it saw, and the hash or the failure. */
type Remembered = { sizeBytes: number; modifiedMs: number; sha256: string | null };

/** The listing's memory of hashes by file name; `hash` is a member so a test can count how often it is used. */
export type HashMemory = {
  files: Map<string, Remembered>;
  hash: (file: string) => Promise<string>;
};

/** The SHA-256 of a regular file, opened without following links and read as a stream. */
async function hashFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('Not a regular file');
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** An empty memory; one lives as long as the server, so a restart simply hashes the folder again. */
export function createHashMemory(hash: (file: string) => Promise<string> = hashFile): HashMemory {
  return { files: new Map(), hash };
}

/** `GET /inbox` (contracts/api.md): the folder as configured and its top-level regular files with their states. */
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

/** What the listing needs of the intake: the database, the folder and the size limit. */
export type ListingDeps = Pick<IntakeDeps, 'pool' | 'inboxDir' | 'maxBytes'>;

/**
 * Lists the regular files at the top level of the inbox with the state of each (FR-061): a file over the size limit is
 * skipped without being hashed; any other is hashed if the memory has not seen it at this size and modified time, and its
 * hash says whether a document has these bytes under any name. A file that cannot be opened is `unreadable` and is not
 * tried again until it changes. Names the folder no longer holds are dropped from the memory.
 */
export async function listInbox(deps: ListingDeps, memory: HashMemory): Promise<InboxListing> {
  const seen: Array<{ name: string; sizeBytes: number; modifiedAt: string; sha256: string | null; tooLarge: boolean }> = [];
  for (const entry of await candidates(deps.inboxDir)) {
    if (!entry.isFile()) {
      continue;
    }
    const file = path.join(deps.inboxDir, entry.name);
    let info;
    try {
      info = await lstat(file);
    } catch {
      continue; // The file went away between the listing and the stat; it is simply not listed.
    }
    const row = { name: entry.name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: null as string | null, tooLarge: info.size > deps.maxBytes };
    if (!row.tooLarge) {
      let remembered = memory.files.get(entry.name);
      if (remembered === undefined || remembered.sizeBytes !== info.size || remembered.modifiedMs !== info.mtimeMs) {
        remembered = { sizeBytes: info.size, modifiedMs: info.mtimeMs, sha256: await memory.hash(file).catch(() => null) };
        memory.files.set(entry.name, remembered);
      }
      row.sha256 = remembered.sha256;
    }
    seen.push(row);
  }
  const names = new Set(seen.map((row) => row.name));
  for (const name of memory.files.keys()) {
    if (!names.has(name)) {
      memory.files.delete(name);
    }
  }
  const numbers = await documentNumbersBySha256(deps.pool, seen.flatMap((row) => (row.sha256 === null ? [] : [row.sha256])));
  const files: InboxFile[] = seen.map((row) => {
    const number = row.sha256 === null ? undefined : numbers.get(row.sha256);
    const state: InboxState = row.tooLarge
      ? { kind: 'skipped', reason: 'too_large' }
      : row.sha256 === null
        ? { kind: 'skipped', reason: 'unreadable' }
        : number === undefined
          ? { kind: 'unread' }
          : { kind: 'document', number };
    return { name: row.name, sizeBytes: row.sizeBytes, modifiedAt: row.modifiedAt, state };
  });
  return { path: deps.inboxDir, files };
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
