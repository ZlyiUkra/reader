import pg from 'pg';
import { constants } from '../constants.ts';

// bigint columns hold identities, byte counts and nanosecond durations, all far below 2^53; `pg` returns them as strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/**
 * Creates the PostgreSQL pool. Connection settings come from the standard PG* environment variables that compose.yaml
 * sets (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), so no connection string with a password is ever assembled or
 * logged. Every query in the application is parameterised (FR-035).
 *
 * An idle client can fail while nobody is waiting on it (the database restarts); `pg` then emits `error` on the pool and
 * the process would crash without a listener, so the caller must say where the error goes.
 *
 * `database` overrides `PGDATABASE`; only the tests pass it, to reach `reader_test` (db/init/003-test-database.sql).
 */
export function createPool(onIdleError: (error: Error) => void, database?: string): pg.Pool {
  const pool = new pg.Pool({ connectionTimeoutMillis: constants.dbConnectTimeoutMs, database });
  pool.on('error', onIdleError);
  return pool;
}
