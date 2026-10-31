import { createHash } from 'node:crypto';
import type { AnySchemaObject, ValidateFunction } from 'ajv/dist/2020.js';
import { createAjv } from '../config/ajv.ts';
import type { TypeSchemaFile } from '../config/load.ts';

/**
 * The schema registry: the single source of the classification list, the prompts, the wire schemas, the checks and the
 * labels the browser shows (constitution II, C10, contracts/type-schema.md). It takes the files that `loadConfig`
 * already parsed and refuses, at start and with a message that names the file and the field, anything the contract does
 * not allow; whatever it hands out afterwards can be trusted without re-checking.
 */

/** The kinds a field can have; they decide how the pipeline reads and checks the value (contracts/type-schema.md). */
export const fieldKinds = ['string', 'date', 'money', 'enum', 'edrpou', 'iban'] as const;
export type FieldKind = (typeof fieldKinds)[number];

/** A label in each interface language (FR-058). */
export type Labels = {
  uk: string;
  en: string;
};

/** One field of a type, in the order the browser shows it. */
export type RegistryField = {
  name: string;
  kind: FieldKind;
  required: boolean;
  labels: Labels;
};

/** A check the pipeline runs on the extracted values of a type (C11); each rule names fields of the same type. */
export type Check =
  | { rule: 'vat_sum'; net: string; vat: string; gross: string; rate: number }
  | { rule: 'date_order'; earlier: string; later: string }
  | { rule: 'edrpou'; field: string }
  | { rule: 'iban_ua'; field: string };

/** One document type of the registry, as derived from one `schemas/<type>.v<n>.json`. */
export type RegistryType = {
  /** The type name, from the file name and equal to the schema's `title`: what the classifier answers and `documents.doc_type` stores. */
  name: string;
  version: number;
  /** The schema's `$id`, stored with every extraction as `schema_id`. */
  schemaId: string;
  file: string;
  labels: Labels;
  fields: RegistryField[];
  checks: Check[];
  /** The canonical schema as read, kept for the wire schema and the value validator. */
  schema: AnySchemaObject;
  /** Validates the typed values of an extraction against the canonical schema before they are written (C10). */
  validate: ValidateFunction;
};

/** The whole registry. */
export type Registry = {
  /** In registry order: the order of the file names, which is the order of the classification list. */
  types: RegistryType[];
  /** SHA-256 of the registry files, sorted by name; stored with every extraction and printed by the evaluation. */
  hash: string;
  byName: Map<string, RegistryType>;
};

/** A registry file the contract does not allow. The message names the file and the cause, because the owner reads it in the logs. */
export class RegistryError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'RegistryError';
  }
}

/** The keywords the canonical schema may use at its top level and on a property (contracts/type-schema.md, rules). */
const topKeywords = ['$schema', '$id', 'title', 'type', 'additionalProperties', 'required', 'properties', 'x-reader'];
const propertyKeywords = ['type', 'enum', 'format', 'pattern', 'x-reader'];

/** The JSON type each kind needs: money is an integer count of kopiyky, everything else is text. */
const jsonTypeOfKind: Record<FieldKind, string> = {
  string: 'string',
  date: 'string',
  money: 'integer',
  enum: 'string',
  edrpou: 'string',
  iban: 'string',
};

/** Narrows an unknown JSON value to an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an unknown value to a string that is not blank. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Reads a `{uk, en}` pair; a missing or blank language is a refusal that names `where`. */
function readLabels(value: unknown, file: string, where: string): Labels {
  if (!isRecord(value) || !isText(value['uk']) || !isText(value['en'])) {
    throw new RegistryError(file, `${where} needs a label in both languages (uk and en).`);
  }
  return { uk: value['uk'], en: value['en'] };
}

/** Narrows an unknown string to one of the field kinds. */
function isFieldKind(value: unknown): value is FieldKind {
  return fieldKinds.some((kind) => kind === value);
}

/** Reads the checks of a type and verifies that every field they name exists and has the kind the rule works on. */
function readChecks(value: unknown, file: string, kinds: Map<string, FieldKind>): Check[] {
  if (!Array.isArray(value)) {
    throw new RegistryError(file, 'x-reader.checks must be a list.');
  }
  const needKind = (name: unknown, kind: FieldKind, where: string): string => {
    if (typeof name !== 'string' || kinds.get(name) !== kind) {
      throw new RegistryError(file, `${where} must name a field of kind ${kind}.`);
    }
    return name;
  };
  return value.map((entry: unknown, index) => {
    const where = `x-reader.checks[${index}]`;
    if (!isRecord(entry)) {
      throw new RegistryError(file, `${where} must be an object.`);
    }
    switch (entry['rule']) {
      case 'vat_sum': {
        const rate = entry['rate'];
        if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0) {
          throw new RegistryError(file, `${where}.rate must be a whole number of percent.`);
        }
        return {
          rule: 'vat_sum',
          net: needKind(entry['net'], 'money', `${where}.net`),
          vat: needKind(entry['vat'], 'money', `${where}.vat`),
          gross: needKind(entry['gross'], 'money', `${where}.gross`),
          rate,
        };
      }
      case 'date_order':
        return {
          rule: 'date_order',
          earlier: needKind(entry['earlier'], 'date', `${where}.earlier`),
          later: needKind(entry['later'], 'date', `${where}.later`),
        };
      case 'edrpou':
        return { rule: 'edrpou', field: needKind(entry['field'], 'edrpou', `${where}.field`) };
      case 'iban_ua':
        return { rule: 'iban_ua', field: needKind(entry['field'], 'iban', `${where}.field`) };
      default:
        throw new RegistryError(file, `${where} has an unknown rule.`);
    }
  });
}

/** Builds one registry type from one file, or refuses it. */
function readType(entry: TypeSchemaFile, validate: (schema: AnySchemaObject) => ValidateFunction): RegistryType {
  const { file, schema } = entry;
  const named = /^([a-z][a-z0-9-]*)\.v([0-9]+)\.json$/.exec(file);
  if (named === null || named[1] === undefined || named[2] === undefined) {
    throw new RegistryError(file, 'the name must be <type>.v<n>.json.');
  }
  const name = named[1];
  const unknownTop = Object.keys(schema).filter((key) => !topKeywords.includes(key));
  if (unknownTop.length > 0) {
    throw new RegistryError(file, `keyword ${unknownTop[0]} is outside the subset every adapter accepts.`);
  }
  if (schema['$id'] !== `https://reader.local/schemas/${file}`) {
    throw new RegistryError(file, `$id must be https://reader.local/schemas/${file}.`);
  }
  if (schema['title'] !== name) {
    throw new RegistryError(file, `title must be ${name}, the type name.`);
  }
  if (schema['type'] !== 'object' || schema['additionalProperties'] !== false) {
    throw new RegistryError(file, 'the schema must be an object with additionalProperties: false.');
  }
  const properties: unknown = schema['properties'];
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    throw new RegistryError(file, 'the schema has no properties.');
  }
  const required: unknown = schema['required'];
  if (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !(key in properties))) {
    throw new RegistryError(file, 'required must list properties of the schema.');
  }
  const typeExtension: unknown = schema['x-reader'];
  if (!isRecord(typeExtension)) {
    throw new RegistryError(file, 'x-reader is missing.');
  }
  const labels = readLabels(typeExtension['labels'], file, 'x-reader.labels');

  const kinds = new Map<string, FieldKind>();
  const fieldLabels = new Map<string, Labels>();
  for (const [key, definition] of Object.entries(properties)) {
    if (!isRecord(definition)) {
      throw new RegistryError(file, `property ${key} must be an object.`);
    }
    const unknownKey = Object.keys(definition).filter((word) => !propertyKeywords.includes(word));
    if (unknownKey.length > 0) {
      throw new RegistryError(file, `property ${key}: keyword ${unknownKey[0]} is outside the subset every adapter accepts.`);
    }
    const extension: unknown = definition['x-reader'];
    if (!isRecord(extension) || !isFieldKind(extension['kind'])) {
      throw new RegistryError(file, `property ${key}: x-reader.kind must be one of ${fieldKinds.join(', ')}.`);
    }
    const kind = extension['kind'];
    if (definition['type'] !== jsonTypeOfKind[kind]) {
      throw new RegistryError(file, `property ${key}: kind ${kind} needs type ${jsonTypeOfKind[kind]}.`);
    }
    if (kind === 'date' && definition['format'] !== 'date') {
      throw new RegistryError(file, `property ${key}: kind date needs format date.`);
    }
    if (kind === 'enum' && !Array.isArray(definition['enum'])) {
      throw new RegistryError(file, `property ${key}: kind enum needs an enum list.`);
    }
    kinds.set(key, kind);
    fieldLabels.set(key, readLabels(extension['labels'], file, `property ${key}`));
  }

  const order: unknown = typeExtension['order'];
  if (!Array.isArray(order) || order.length !== kinds.size || new Set(order).size !== order.length || order.some((key) => typeof key !== 'string' || !kinds.has(key))) {
    throw new RegistryError(file, 'x-reader.order must list every property exactly once.');
  }
  const fields = order.map((key: string): RegistryField => ({
    name: key,
    kind: kinds.get(key) ?? 'string',
    required: required.includes(key),
    labels: fieldLabels.get(key) ?? labels,
  }));

  return {
    name,
    version: Number(named[2]),
    schemaId: schema['$id'],
    file,
    labels,
    fields,
    checks: readChecks(typeExtension['checks'], file, kinds),
    schema,
    validate: validate(schema),
  };
}

/**
 * Builds the registry from the files `loadConfig` read, or refuses to. Besides each file's own rules, one type name may
 * appear once: the prototype keeps one version per type, and a second version of a type is a decision for the owner (it
 * would need a rule for which one the classifier names), so it stops here instead of picking one.
 */
export function createRegistry(files: TypeSchemaFile[]): Registry {
  const ajv = createAjv();
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const types = sorted.map((entry) =>
    readType(entry, (schema) => {
      try {
        return ajv.compile(schema);
      } catch (error) {
        throw new RegistryError(entry.file, `the schema does not compile in strict mode: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  const seen = new Set<string>();
  for (const type of types) {
    if (seen.has(type.name)) {
      throw new RegistryError(type.file, `a second version of the type ${type.name}; the prototype keeps one version per type.`);
    }
    seen.add(type.name);
  }
  const hash = createHash('sha256');
  for (const entry of sorted) {
    hash.update(entry.file).update('\0').update(entry.text).update('\0');
  }
  return { types, hash: hash.digest('hex'), byName: new Map(types.map((type) => [type.name, type])) };
}
