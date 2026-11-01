import type { FastifyInstance } from 'fastify';
import { countDocuments, listDocuments, reasonsOfDocuments } from '../db/queries.ts';
import type { ReasonRow } from '../db/queries.ts';
import type { IntakeDeps } from '../intake/take.ts';

/**
 * `GET /api/documents` (contracts/api.md, FR-053, FR-054): the documents table, newest first. A row carries the status
 * columns and the reasons as `{code, params}`; it never carries a page text, a fragment or anything the model said, and the
 * message of a reason is not in it either: the page renders messages from the templates of `/api/meta` in the language
 * the owner chose. Reasons of all listed documents are read in one statement, so a poll every two seconds costs three
 * small queries. `count` is the number of documents there are, not of the rows returned: the re-read check watches it (FR-003).
 */

/** What the document routes read from outside the module: the pool and the blob root the page previews live under. */
export type DocumentsDeps = Pick<IntakeDeps, 'pool' | 'blobRoot'>;

/** The `reasons` of a list row and of the detail view share these two members. */
export const reasonShape = {
  type: 'object',
  required: ['code', 'params'],
  properties: { code: { type: 'string' }, params: { type: 'object', additionalProperties: true } },
} as const;

const listSchema = {
  type: 'object',
  required: ['documents', 'count'],
  properties: {
    documents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'sha256', 'originalName', 'class', 'type', 'status', 'attempts', 'createdAt', 'updatedAt', 'reasons'],
        properties: {
          number: { type: 'integer' },
          sha256: { type: 'string' },
          originalName: { type: ['string', 'null'] },
          class: { type: 'string' },
          type: { type: ['string', 'null'] },
          status: { type: 'string' },
          attempts: { type: 'integer' },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          reasons: { type: 'array', items: reasonShape },
        },
      },
    },
    count: { type: 'integer' },
  },
} as const;

/** How many rows the table gets when the request does not say, and the most it may ask for (contracts/api.md). */
const defaultLimit = 200;
const maxLimit = 1000;

/** Groups reason rows by document, keeping the order the database returned them in. */
function groupByDocument(rows: ReasonRow[]): Map<number, Array<{ code: string; params: Record<string, string | number> }>> {
  const grouped = new Map<number, Array<{ code: string; params: Record<string, string | number> }>>();
  for (const row of rows) {
    const list = grouped.get(row.document_id) ?? [];
    list.push({ code: row.code, params: row.params });
    grouped.set(row.document_id, list);
  }
  return grouped;
}

/** Registers the list route on the `/api` instance. */
export function registerDocuments(api: FastifyInstance, deps: DocumentsDeps): void {
  api.get<{ Querystring: { limit: number } }>(
    '/documents',
    {
      schema: {
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit } } },
        response: { 200: listSchema },
      },
    },
    async (request) => {
      const [rows, count] = await Promise.all([listDocuments(deps.pool, request.query.limit), countDocuments(deps.pool)]);
      const reasons = groupByDocument(rows.length === 0 ? [] : await reasonsOfDocuments(deps.pool, rows.map((row) => row.id)));
      return {
        documents: rows.map((row) => ({
          number: row.id,
          sha256: row.sha256,
          originalName: row.original_name,
          class: row.class,
          type: row.doc_type,
          status: row.status,
          attempts: row.attempts,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          reasons: reasons.get(row.id) ?? [],
        })),
        count,
      };
    },
  );
}
