import type { FastifyInstance } from 'fastify';
import type { Reasons } from '../reasons/reasons.ts';
import type { Registry } from '../registry/registry.ts';

/**
 * `GET /api/meta` (contracts/api.md, FR-041, FR-058): everything the page derives from the registry and the reasons
 * file, fetched once at page load, so the page keeps no field label, field order or message template of its own. It is
 * built once at start from the two modules, which have already refused anything inconsistent.
 */

/** What the meta route reads from outside the module. */
export type MetaDeps = {
  registry: Registry;
  reasons: Reasons;
  /** The page size the lists start with and the sizes the page offers (`ui.page_size`, `ui.page_size_options`). */
  pageSize: number;
  pageSizes: number[];
};

const labelsSchema = { type: 'object', required: ['uk', 'en'], properties: { uk: { type: 'string' }, en: { type: 'string' } } } as const;

/** Registers the route on the `/api` instance. */
export function registerMeta(api: FastifyInstance, deps: MetaDeps): void {
  const meta = {
    languages: ['uk', 'en'],
    defaultLanguage: 'uk',
    types: deps.registry.types.map((type) => ({
      name: type.name,
      schemaId: type.schemaId,
      labels: type.labels,
      fields: type.fields.map((field) => ({ name: field.name, kind: field.kind, required: field.required, labels: field.labels })),
    })),
    reasons: deps.reasons.entries.map((entry) => ({
      code: entry.code,
      outcome: entry.outcome,
      emitted: entry.emitted,
      templates: entry.templates,
      params: entry.params.map((param) => param.name),
      variants: entry.variants?.map((variant) => ({
        when: variant.when,
        params: variant.params.map((param) => param.name),
        templates: variant.templates,
      })),
    })),
    pageSize: deps.pageSize,
    pageSizes: deps.pageSizes,
  };

  api.get(
    '/meta',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['languages', 'defaultLanguage', 'types', 'reasons', 'pageSize', 'pageSizes'],
            properties: {
              languages: { type: 'array', items: { type: 'string' } },
              defaultLanguage: { type: 'string' },
              types: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'schemaId', 'labels', 'fields'],
                  properties: {
                    name: { type: 'string' },
                    schemaId: { type: 'string' },
                    labels: labelsSchema,
                    fields: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['name', 'kind', 'required', 'labels'],
                        properties: { name: { type: 'string' }, kind: { type: 'string' }, required: { type: 'boolean' }, labels: labelsSchema },
                      },
                    },
                  },
                },
              },
              reasons: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['code', 'outcome', 'emitted', 'templates', 'params'],
                  properties: {
                    code: { type: 'string' },
                    outcome: { type: 'string' },
                    emitted: { type: 'boolean' },
                    templates: labelsSchema,
                    params: { type: 'array', items: { type: 'string' } },
                    variants: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['when', 'params', 'templates'],
                        properties: {
                          when: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
                          params: { type: 'array', items: { type: 'string' } },
                          templates: labelsSchema,
                        },
                      },
                    },
                  },
                },
              },
              pageSize: { type: 'integer' },
              pageSizes: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
      },
    },
    async () => meta,
  );
}
