import type pg from 'pg';
import { createPool } from '../../src/db/pool.ts';
import { insertDocument } from '../../src/db/queries.ts';
import type { NewDocument } from '../../src/db/queries.ts';

/**
 * The real PostgreSQL for the tests that need one (research R10: the `db` service, not a fake). They connect to
 * `reader_test`, a second database on the same server (db/init/003-test-database.sql), because the application role cannot
 * delete rows and a row added by a test would stay in the owner's database and take a visible document number. The pool is
 * created with that name regardless of `PGDATABASE`, and a check refuses to go on if the connection is anywhere else.
 *
 * `node --test` runs the files side by side, and a worker in one file would claim documents another file just added. So a
 * test file takes a session-level advisory lock for its whole run, and the files that use the database run one after
 * another.
 */

/** The statuses in which a document waits for or is in a step. */
const openStatuses = ['RECEIVED', 'PARSE', 'CLASSIFY', 'EXTRACT', 'CHECK'];

/** The key of the advisory lock the database tests share. Any fixed number would do. */
const advisoryLockKey = 727_001;

/** Ends every document that waits for or is in a step (status REJECTED, lock cleared), so one test's rows never reach another's worker. */
export async function endOpenDocuments(pool: pg.Pool): Promise<void> {
  await pool.query('UPDATE documents SET status = $1, locked_until = NULL, locked_by = NULL WHERE status = ANY($2::text[])', ['REJECTED', openStatuses]);
}

/** A pool on the test database, holding the lock until `close` is called. */
export type TestDatabase = {
  pool: pg.Pool;
  close: () => Promise<void>;
};

/**
 * Opens a pool on `reader_test`, waits for the lock, and ends every document an earlier run left open (status REJECTED), so
 * a test that failed halfway does not hand its rows to the next test's worker. The status column is one the role may update.
 */
export async function testDatabase(): Promise<TestDatabase> {
  const pool = createPool((error) => console.error(`Idle test client failed: ${error.message}`), 'reader_test');
  const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
  if (database.rows[0]?.name !== 'reader_test') {
    await pool.end();
    throw new Error('The database tests must run on reader_test and nowhere else');
  }
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
  await endOpenDocuments(pool);
  return {
    pool,
    close: async () => {
      // Destroying the connection that holds the lock releases it for the next file.
      lock.release(new Error('release the advisory lock'));
      await pool.end();
    },
  };
}

let counter = 0;

/** A 64-character lowercase hex string that no other call returns, for a document hash. */
export function uniqueSha256(): string {
  counter += 1;
  return `${Date.now().toString(16)}${process.pid.toString(16)}${counter.toString(16)}`.padStart(64, '0').slice(-64);
}

/** Adds a `RECEIVED` document with a new hash and returns its number and hash. */
export async function addDocument(pool: pg.Pool, overrides: Partial<NewDocument> = {}): Promise<{ id: number; sha256: string }> {
  const sha256 = overrides.sha256 ?? uniqueSha256();
  const id = await insertDocument(pool, {
    sha256,
    originalName: 'test.pdf',
    originalPath: null,
    sizeBytes: 10,
    documentClass: 'synthetic',
    blobKey: `blobs/${sha256.slice(0, 2)}/${sha256}`,
    ...overrides,
  });
  if (id === null) {
    throw new Error('The test document was not inserted');
  }
  return { id, sha256 };
}

/** The status, attempts and lock of a document, for assertions. */
export async function stateOf(pool: pg.Pool, id: number): Promise<{ status: string; attempts: number; locked_by: string | null; locked_until: Date | null }> {
  const result = await pool.query<{ status: string; attempts: number; locked_by: string | null; locked_until: Date | null }>(
    'SELECT status, attempts, locked_by, locked_until FROM documents WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Document ${id} is not there`);
  }
  return row;
}
