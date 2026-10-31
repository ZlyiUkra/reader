import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type { Ajv2020, AnySchemaObject, ValidateFunction } from 'ajv/dist/2020.js';
import { createContractValidators } from './ajv.ts';
import type { ClassesFile, ModelConfig, ReasonsFile, ThresholdsFile } from './types.ts';

/**
 * A refusal to start because the configuration is wrong. The message names the cause, because the owner reads it in
 * `docker compose logs` and has to know what to fix (FR-007, FR-034, SC-009). It is an Error subclass, never a string.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The two folders the application reads at start; in containers they are read-only bind mounts (contracts/compose.md). */
export type ConfigDirs = {
  configDir: string;
  schemasDir: string;
};

/**
 * One file of the schema registry as read from disk. The registry module derives everything else from it (T019); the text
 * is kept as read because the registry hash is taken over the files themselves (contracts/type-schema.md).
 */
export type TypeSchemaFile = {
  file: string;
  schema: AnySchemaObject;
  text: string;
};

/** Everything the application reads from files at start, validated. */
export type LoadedConfig = {
  thresholds: ThresholdsFile;
  classes: ClassesFile;
  reasons: ReasonsFile;
  model: ModelConfig;
  typeSchemas: TypeSchemaFile[];
};

/** File names of the registry: `<type>.v<n>.json`, the version being part of the name (FR-040). */
const typeSchemaFileName = /^[a-z][a-z0-9-]*\.v[0-9]+\.json$/;

/**
 * Takes the folders from the environment (`READER_CONFIG_DIR`, `READER_SCHEMAS_DIR`, set by compose.yaml) and falls back
 * to the folders of the repository, so the same code runs on the host and in the container.
 */
export function resolveConfigDirs(env: NodeJS.ProcessEnv): ConfigDirs {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  return {
    configDir: env['READER_CONFIG_DIR'] ?? path.join(repositoryRoot, 'config'),
    schemasDir: env['READER_SCHEMAS_DIR'] ?? path.join(repositoryRoot, 'schemas'),
  };
}

/** Narrows an unknown JSON value to an object, for the checks that run before a schema can be trusted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a text file; a failure is a ConfigError that names the file. */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parses JSON text; the result is `unknown` until a validator has accepted it. */
function parseJson(text: string, file: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads and parses a JSON file; the result is `unknown` until a validator has accepted it. */
async function readJson(file: string): Promise<unknown> {
  return parseJson(await readText(file), file);
}

/**
 * Fails closed on the egress rule (constitution IV, FR-007): a class that does not say whether its content may leave
 * the machine stops the application, and the message names the class. Runs on the raw data, before the schema, so the
 * owner sees the class name and not a generic "must have required property" error.
 */
function assertEveryClassHasEgressRule(data: unknown, file: string): void {
  if (!isRecord(data) || !Array.isArray(data['classes'])) return;
  for (const entry of data['classes']) {
    if (isRecord(entry) && typeof entry['may_leave'] !== 'boolean') {
      const name = typeof entry['name'] === 'string' ? entry['name'] : '(unnamed)';
      throw new ConfigError(`Sensitivity class "${name}" has no egress rule: set may_leave to true or false in ${file}.`);
    }
  }
}

/**
 * Loads and validates config/*.json and the files of the schema registry. Every failure is a ConfigError that names the
 * file or the class. The registry files are only checked to be valid JSON Schema here; the registry module derives the
 * wire schemas, labels and checks from them and validates the `x-reader` keys.
 */
export async function loadConfig(dirs: ConfigDirs): Promise<LoadedConfig> {
  const validators = await createContractValidators();
  const { ajv } = validators;

  async function loadValidated<T>(fileName: string, validate: ValidateFunction<T>): Promise<T> {
    const file = path.join(dirs.configDir, fileName);
    const data = await readJson(file);
    if (fileName === 'classes.json') assertEveryClassHasEgressRule(data, file);
    if (!validate(data)) {
      const detail = ajv.errorsText(validate.errors, { dataVar: fileName });
      throw new ConfigError(`${file} does not match its contract: ${detail}`);
    }
    return data;
  }

  const thresholds = await loadValidated('thresholds.json', validators.thresholds);
  const classes = await loadValidated('classes.json', validators.classes);
  const reasons = await loadValidated('reasons.json', validators.reasons);
  const model = await loadValidated('model.json', validators.model);

  const codes = reasons.reasons.map((entry) => entry.code);
  const duplicate = codes.find((code, index) => codes.indexOf(code) !== index);
  if (duplicate !== undefined) {
    throw new ConfigError(`${path.join(dirs.configDir, 'reasons.json')} declares the code ${duplicate} twice.`);
  }

  return { thresholds, classes, reasons, model, typeSchemas: await loadTypeSchemas(dirs.schemasDir, ajv) };
}

/** Reads the registry folder: only `<type>.v<n>.json` names, each a valid JSON Schema, at least one file. */
async function loadTypeSchemas(schemasDir: string, ajv: Ajv2020): Promise<TypeSchemaFile[]> {
  let names: string[];
  try {
    names = (await readdir(schemasDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    throw new ConfigError(`Cannot read the schema registry folder ${schemasDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (names.length === 0) {
    throw new ConfigError(`The schema registry folder ${schemasDir} has no type schema.`);
  }
  const files: TypeSchemaFile[] = [];
  for (const name of names) {
    if (!typeSchemaFileName.test(name)) {
      throw new ConfigError(`${path.join(schemasDir, name)} is not named <type>.v<n>.json.`);
    }
    const text = await readText(path.join(schemasDir, name));
    const schema = parseJson(text, path.join(schemasDir, name));
    if (!isRecord(schema) || ajv.validateSchema(schema) !== true) {
      throw new ConfigError(`${path.join(schemasDir, name)} is not a valid JSON Schema (draft 2020-12).`);
    }
    files.push({ file: name, schema, text });
  }
  return files;
}

/**
 * The startup entry: loads the configuration and, on a refusal, prints the cause to stderr and exits with a non-zero
 * code (acceptance check 6, SC-009). Anything that is not a ConfigError is a defect and propagates.
 */
export async function loadConfigOrExit(env: NodeJS.ProcessEnv): Promise<LoadedConfig> {
  try {
    return await loadConfig(resolveConfigDirs(env));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Refusing to start: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
