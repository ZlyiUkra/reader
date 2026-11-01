import { readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ClassesFile, ModelConfig, ParserManifest, ReasonsFile, ThresholdsFile } from './types.ts';

/**
 * The Ajv factory of the application and the validators compiled from the contract schemas (research R1, R6).
 * Draft 2020-12, strict mode, `format: date` from ajv-formats. Union types such as ["string", "null"] are allowed
 * because the parser manifest and the reasons file use them on purpose; every other strict check stays on. The
 * vendor keyword `x-reader` of the type schemas is registered as an annotation, because strict mode rejects a keyword it
 * does not know, and it validates nothing: the registry checks its content (contracts/type-schema.md).
 */
export type ContractValidators = {
  ajv: Ajv2020;
  thresholds: ValidateFunction<ThresholdsFile>;
  classes: ValidateFunction<ClassesFile>;
  reasons: ValidateFunction<ReasonsFile>;
  model: ValidateFunction<ModelConfig>;
  parserManifest: ValidateFunction<ParserManifest>;
};

/**
 * ajv-formats is a CommonJS module whose default export sits one level down under native ESM and `nodenext`
 * resolution; this picks the callable plugin out of it.
 */
const addFormats = addFormatsModule.default;

/** Where the copies of the contract schemas live: next to this file, so they travel with the code (T012). */
const schemasDir = path.join(import.meta.dirname, 'schemas');

/**
 * Creates the Ajv instance every validator of the application is compiled with. Strict mode makes a misspelt keyword
 * in a schema a startup error instead of a silently ignored rule (constitution XI).
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-reader', schemaType: 'object' });
  return ajv;
}

/** Reads one schema file of the contract copies and parses it; a failure here is a defect of the build, not of the data. */
async function readContract(fileName: string): Promise<object> {
  const parsed: unknown = JSON.parse(await readFile(path.join(schemasDir, fileName), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${fileName} is not a JSON object`);
  }
  return parsed;
}

/**
 * Compiles the contract of the evaluation report (`eval-report.schema.json`, FR-048a). The evaluation validates every report
 * before it writes it, so a report that does not match its contract is never saved.
 */
export async function createEvalReportValidator(): Promise<ValidateFunction> {
  return createAjv().compile(await readContract('eval-report.schema.json'));
}

/**
 * Compiles the validators of the configuration files and of the parser manifest. Called once at start; the result is
 * passed to whoever validates input, so no module compiles its own copy of a contract.
 */
export async function createContractValidators(): Promise<ContractValidators> {
  const ajv = createAjv();
  return {
    ajv,
    thresholds: ajv.compile<ThresholdsFile>(await readContract('thresholds.schema.json')),
    classes: ajv.compile<ClassesFile>(await readContract('classes.schema.json')),
    reasons: ajv.compile<ReasonsFile>(await readContract('reasons.schema.json')),
    model: ajv.compile<ModelConfig>(await readContract('model-config.schema.json')),
    parserManifest: ajv.compile<ParserManifest>(await readContract('parser-manifest.schema.json')),
  };
}
