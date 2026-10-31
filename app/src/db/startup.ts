import type pg from 'pg';

/**
 * The database was initialised with another schema than this build expects, or not at all. A schema change means
 * `docker compose down -v` (FR-034, named simplification: no migrations), and the message says so.
 */
export class SchemaVersionError extends Error {
  found: number | null;
  expected: number;

  constructor(found: number | null, expected: number) {
    const was = found === null ? 'has no version row' : `is at version ${found}`;
    super(`The database schema ${was}, but this application expects version ${expected}. Reset the storage with "docker compose down -v" and start again.`);
    this.name = 'SchemaVersionError';
    this.found = found;
    this.expected = expected;
  }
}

/**
 * Refuses to run on a mismatch (FR-034, SC-009): reads the single row of `schema_version` and compares it with the
 * version compiled into the application. More or fewer than one row counts as "no version", because the table is meant
 * to hold exactly one.
 */
export async function assertSchemaVersion(pool: pg.Pool, expected: number): Promise<void> {
  const result = await pool.query<{ version: number }>('SELECT version FROM schema_version');
  const [only, ...rest] = result.rows;
  if (only === undefined || rest.length > 0 || only.version !== expected) {
    throw new SchemaVersionError(only !== undefined && rest.length === 0 ? only.version : null, expected);
  }
}
