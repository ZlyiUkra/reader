import pg from 'pg';
import { constants } from '../constants.ts';

/**
 * Creates the PostgreSQL pool. Connection settings come from the standard PG* environment variables that compose.yaml
 * sets (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), so no connection string with a password is ever assembled or
 * logged. Every query in the application is parameterised (FR-035).
 *
 * An idle client can fail while nobody is waiting on it (the database restarts); `pg` then emits `error` on the pool and
 * the process would crash without a listener, so the caller must say where the error goes.
 */
export function createPool(onIdleError: (error: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionTimeoutMillis: constants.dbConnectTimeoutMs });
  pool.on('error', onIdleError);
  return pool;
}
