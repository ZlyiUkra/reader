import type pg from 'pg';

/**
 * Anything that runs a parameterised query: the pool, or a client inside a transaction. The query helpers take this type,
 * so the same function serves a single statement and a step that must commit several together (FR-030, FR-035).
 */
export type Queryable = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
};

/**
 * Runs `work` in one transaction on one connection and commits when it returns, rolls back when it throws. A step's state
 * change and its output must commit together (constitution III, FR-030); this is the only place a transaction is opened.
 * If the rollback itself fails the connection is broken, so it is released with the error and the pool drops it.
 */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
