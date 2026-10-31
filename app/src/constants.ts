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

  /**
   * Attempts after which a step that keeps ending in INTERNAL_ERROR makes the document FAILED (FR-026, FR-027). A rule
   * of the status function, not a tunable of the pipeline, so it lives here and not in config/thresholds.json.
   */
  maxAttempts: 3,

  /**
   * How long a failed model readiness check (a missing digest, a context mismatch, a failed warm-up) is not repeated.
   * `GET /api/health` is polled every two seconds and each real check runs a model call, so without a pause a model
   * that is not ready would be hit with a warm-up every poll. A guard, not a pipeline threshold.
   */
  readinessRetryMs: 10_000,

  /**
   * The most bytes read from one reply of the model service. A reply is bounded by `num_predict`, so this is far above
   * any real one; it stops a misbehaving server from filling memory (AGENTS.md: nothing is read whole before its cap).
   */
  maxModelReplyBytes: 4_194_304,

  /** Tokens the readiness warm-up may generate: the trivial schema it sends needs a handful. */
  warmupNumPredict: 16,
};
