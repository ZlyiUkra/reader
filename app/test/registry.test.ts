import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import type { TypeSchemaFile } from '../src/config/load.ts';
import { classifyPrompt, extractPrompt } from '../src/registry/prompt.ts';
import { createRegistry, RegistryError } from '../src/registry/registry.ts';
import { classifySchema, wireSchema } from '../src/registry/wire.ts';

/**
 * The registry against the real schema files and against a fourth type (T070, acceptance check 10, FR-040, FR-041):
 * adding a schema file changes the classification list, the hash, the labels and the prompts and nothing else, and a
 * file that breaks the contract is refused with a message that names the file and the cause.
 */
const real = (await loadConfig(resolveConfigDirs(process.env))).typeSchemas;
const receiptText = await readFile(path.join(import.meta.dirname, 'fixtures', 'registry', 'receipt.v1.json'), 'utf8');

/** A registry file built from a schema object, as `loadConfig` would hand it over. */
function file(name: string, schema: object): TypeSchemaFile {
  return { file: name, schema: structuredClone(schema), text: JSON.stringify(schema) };
}

/** Narrows an unknown JSON value to an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The receipt fixture as a parsed object, to be damaged by the refusal cases. */
function receipt(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(receiptText);
  if (!isRecord(parsed)) {
    throw new Error('The receipt fixture is not an object');
  }
  return parsed;
}

/** Marks a key to be deleted by `change`. */
const gone = Symbol('gone');

/** Sets, or with `gone` deletes, the value at `path` inside a parsed schema; a path that does not exist is a defect of the test. */
function change(schema: Record<string, unknown>, path: string[], value: unknown): void {
  let node: unknown = schema;
  for (const key of path.slice(0, -1)) {
    node = isRecord(node) ? node[key] : undefined;
  }
  const last = path[path.length - 1];
  if (!isRecord(node) || last === undefined) {
    throw new Error(`The fixture has no ${path.join('.')}`);
  }
  if (value === gone) {
    delete node[last];
  } else {
    node[last] = value;
  }
}

/** Refusals: [name, the changes to the receipt, the file name it is loaded under, a part of the message]. */
const refusals: Array<[string, Array<[string[], unknown]>, string, RegExp]> = [
  ['a type label without Ukrainian', [[['x-reader', 'labels', 'uk'], gone]], 'receipt.v1.json', /x-reader\.labels needs a label in both languages/],
  ['a type label without English', [[['x-reader', 'labels', 'en'], gone]], 'receipt.v1.json', /x-reader\.labels needs a label in both languages/],
  ['a blank field label', [[['properties', 'total', 'x-reader', 'labels', 'uk'], '  ']], 'receipt.v1.json', /property total needs a label in both languages/],
  ['a field without English', [[['properties', 'date', 'x-reader', 'labels', 'en'], gone]], 'receipt.v1.json', /property date needs a label in both languages/],
  ['a missing x-reader', [[['x-reader'], gone]], 'receipt.v1.json', /x-reader is missing/],
  ['a wrong $id', [[['$id'], 'https://reader.local/schemas/other.v1.json']], 'receipt.v1.json', /\$id must be https:\/\/reader\.local\/schemas\/receipt\.v1\.json/],
  ['a wrong title', [[['title'], 'bill']], 'receipt.v1.json', /title must be receipt/],
  ['a file name without a version', [], 'receipt.json', /the name must be <type>\.v<n>\.json/],
  ['a keyword outside the subset', [[['oneOf'], []]], 'receipt.v1.json', /keyword oneOf is outside the subset/],
  ['a property keyword outside the subset', [[['properties', 'number', 'maxLength'], 10]], 'receipt.v1.json', /property number: keyword maxLength is outside the subset/],
  ['an unknown kind', [[['properties', 'number', 'x-reader', 'kind'], 'phone']], 'receipt.v1.json', /property number: x-reader\.kind must be one of/],
  ['money that is not an integer', [[['properties', 'total', 'type'], 'number']], 'receipt.v1.json', /property total: kind money needs type integer/],
  ['a date without the date format', [[['properties', 'date', 'format'], gone]], 'receipt.v1.json', /property date: kind date needs format date/],
  ['an order that misses a property', [[['x-reader', 'order'], ['number', 'date']]], 'receipt.v1.json', /order must list every property exactly once/],
  ['an order that repeats a property', [[['x-reader', 'order'], ['number', 'date', 'date']]], 'receipt.v1.json', /order must list every property exactly once/],
  ['a required field that is not a property', [[['required'], ['number', 'nothing']]], 'receipt.v1.json', /required must list properties of the schema/],
  ['a check on a field that is missing', [[['x-reader', 'checks'], [{ rule: 'edrpou', field: 'nothing' }]]], 'receipt.v1.json', /checks\[0\]\.field must name a field of kind edrpou/],
  ['a check on a field of the wrong kind', [[['x-reader', 'checks'], [{ rule: 'iban_ua', field: 'number' }]]], 'receipt.v1.json', /checks\[0\]\.field must name a field of kind iban/],
  ['an unknown rule', [[['x-reader', 'checks'], [{ rule: 'luhn', field: 'number' }]]], 'receipt.v1.json', /checks\[0\] has an unknown rule/],
  ['a VAT rate that is not whole percent', [[['x-reader', 'checks'], [{ rule: 'vat_sum', net: 'total', vat: 'total', gross: 'total', rate: 20.5 }]]], 'receipt.v1.json', /rate must be a whole number of percent/],
];

for (const [name, changes, fileName, message] of refusals) {
  test(`refused: ${name}`, () => {
    const schema = receipt();
    for (const [path, value] of changes) {
      change(schema, path, value);
    }
    assert.throws(
      () => createRegistry([...real, file(fileName, schema)]),
      (error: unknown) => error instanceof RegistryError && error.message.startsWith(`${fileName}: `) && message.test(error.message),
    );
  });
}

test('refused: a second version of a type', () => {
  const second = receipt();
  change(second, ['$id'], 'https://reader.local/schemas/receipt.v2.json');
  assert.throws(
    () => createRegistry([file('receipt.v1.json', receipt()), file('receipt.v2.json', second)]),
    (error: unknown) => error instanceof RegistryError && /a second version of the type receipt/.test(error.message),
  );
});
