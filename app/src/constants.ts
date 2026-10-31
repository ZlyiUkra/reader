/**
 * App-level constants, grouped in one object (AGENTS.md: camelCase, one export). Tunable numbers of the pipeline are
 * not here: they are rows of config/thresholds.json (C13), loaded once at start.
 */
export const constants = {
  /**
   * The database schema version this build expects. It must equal the single row of `schema_version`; a mismatch
   * stops the application at start (FR-034). Raised together with db/init/002-schema.sql.
   */
  schemaVersion: 1,

  /**
   * How long the first connection to PostgreSQL may take before the startup check gives up. A guard against waiting
   * forever on a database that is not there, not a pipeline threshold.
   */
  dbConnectTimeoutMs: 10_000,
};
