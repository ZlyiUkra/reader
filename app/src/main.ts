import { access } from 'node:fs/promises';
import path from 'node:path/posix';
import { ConfigError, loadConfigOrExit } from './config/load.ts';
import { logTodoWarnings } from './config/todo.ts';
import { constants } from './constants.ts';
import { createPool } from './db/pool.ts';
import { assertSchemaVersion, SchemaVersionError } from './db/startup.ts';
import { createOllamaAdapter } from './llm/ollama.ts';
import { modelSettings } from './llm/settings.ts';
import { createReasons, ReasonsError } from './reasons/reasons.ts';
import { createRegistry, RegistryError } from './registry/registry.ts';
import { buildServer } from './server.ts';

/**
 * The entry point of the application. The start order is the one the specification fixes: the configuration (which
 * includes the sensitivity classes and their egress rule), then the database schema version, then the registry and the
 * reasons, and only then the server. Any refusal prints its cause and exits non-zero, so a wrong setup is a stopped
 * container with a message in `docker compose logs`, never a server that half works (FR-007, FR-034, SC-009).
 */

/** Prints why the application will not start and ends the process with a non-zero code. */
function refuse(message: string): never {
  console.error(`Refusing to start: ${message}`);
  process.exit(1);
}

const env = process.env;

const config = await loadConfigOrExit(env);

const sandbox = env['READER_SANDBOX_RUNTIME'];
if (sandbox === undefined || sandbox === '') {
  refuse('READER_SANDBOX_RUNTIME is not set; compose.yaml sets it to the parser\'s runtime.');
}

const modelUrl = env['MODEL_URL'];
if (modelUrl === undefined || modelUrl === '') {
  refuse('MODEL_URL is not set; compose.yaml sets it to the model service.');
}

let settings;
try {
  settings = modelSettings(config.thresholds);
} catch (error) {
  if (error instanceof ConfigError) {
    refuse(error.message);
  }
  throw error;
}

const webRoot = path.resolve(import.meta.dirname, '..', 'dist', 'web');
try {
  await access(path.join(webRoot, 'index.html'));
} catch {
  refuse(`The built front is missing at ${webRoot}; build it with "yarn build:web".`);
}

const pool = createPool((error) => console.error(`Idle database client failed: ${error.message}`));
try {
  await assertSchemaVersion(pool, constants.schemaVersion);
} catch (error) {
  if (error instanceof SchemaVersionError) {
    refuse(error.message);
  }
  refuse(`The database could not be read: ${error instanceof Error ? error.message : String(error)}`);
}

let reasons;
let registry;
try {
  reasons = createReasons(config.reasons);
  registry = createRegistry(config.typeSchemas);
} catch (error) {
  if (error instanceof ReasonsError || error instanceof RegistryError) {
    refuse(error.message);
  }
  throw error;
}

// The adapter logs through the server's logger, which exists only once the server is built; the closures run later.
const modelAdapter = createOllamaAdapter({
  baseUrl: modelUrl,
  model: config.model,
  settings,
  logger: {
    info: (fields, message) => app.log.info(fields, message),
    warn: (fields, message) => app.log.warn(fields, message),
  },
});

const listenPort = Number(env['READER_PORT'] ?? '3000');
const publicPort = Number(env['READER_PUBLIC_PORT'] ?? listenPort);

const app = await buildServer({
  logger: true,
  publicPort,
  webRoot,
  registry,
  reasons,
  sandbox,
  checkDb: async () => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (error) {
      app.log.warn({ cause: error instanceof Error ? error.message : String(error) }, 'The database did not answer the health query.');
      return false;
    }
  },
  // The model is ready only for the pinned digest after a warm-up (FR-037); until then no step is claimed.
  readiness: () => modelAdapter.readiness(),
});

logTodoWarnings(app.log);
await app.listen({ host: env['READER_LISTEN_HOST'] ?? '127.0.0.1', port: listenPort });
