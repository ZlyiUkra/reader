import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { RegistryType } from './registry.ts';

/**
 * What the model receives as the response format, derived from the registry and nowhere else (contracts/type-schema.md,
 * constitution II). Both functions are pure and snapshot-tested per type, so a change to a type schema that alters the
 * wire schema shows up as a failing snapshot and not as a different model behaviour weeks later.
 */

/** A JSON Schema object, in the subset every adapter accepts. */
export type WireSchema = Record<string, unknown>;

/**
 * The wire schema of one type: every property becomes `{verbatim, page}`, both nullable, so the model returns the quoted
 * fragment and its page, or `null` for both when the field is not on the document. All properties are required at the wire
 * level, which gives every field an explicit absent path; the business `required` of the canonical schema is the
 * pipeline's check, not the model's. No `x-` key, no `format`, `pattern` or `enum`: the value is derived from the fragment
 * and checked by the pipeline (FR-017, FR-018).
 */
export function wireSchema(type: RegistryType): WireSchema {
  const names = type.fields.map((field) => field.name);
  return {
    type: 'object',
    required: names,
    additionalProperties: false,
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: 'object',
          required: ['verbatim', 'page'],
          additionalProperties: false,
          properties: {
            verbatim: { type: ['string', 'null'] },
            page: { type: ['integer', 'null'] },
          },
        },
      ]),
    ),
  };
}

/** SHA-256 of a wire schema with its keys sorted: stored with every extraction, so a changed schema shows in the data (FR-032). */
export function wireSchemaHash(schema: WireSchema): string {
  return createHash('sha256').update(canonicalJson(schema)).digest('hex');
}

/**
 * The classification request schema: one answer, a type name from the registry or `none`, in registry order. The list is
 * closed by construction, so adding a schema file and restarting is all it takes to make the classifier able to name it
 * (acceptance check 10).
 */
export function classifySchema(typeNames: string[]): WireSchema {
  return {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties: {
      type: { enum: [...typeNames, 'none'] },
    },
  };
}
