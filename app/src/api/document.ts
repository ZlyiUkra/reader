import type { FastifyInstance } from 'fastify';
import { documentByNumber, fieldsWithPageOf, modelCallsOf, pagesOf, reasonsOf, stepRunsOf } from '../db/queries.ts';
import { HttpError } from '../http-error.ts';
import { reasonShape } from './documents.ts';
import type { DocumentsDeps } from './documents.ts';

/**
 * `GET /api/documents/{number}` (contracts/api.md, FR-053, FR-055): everything the detail view shows about one document:
 * its fields with the fragment, page and offsets of each, the pages, the attempts of every step with their durations, the
 * model identity and the reasons. Page texts and the raw model request and response are not here (FR-054, FR-053a): the
 * fragment of a field is the model's quote, which the page shows as text, and the raw calls have their own route.
 */

/** The number of a document in a path; it is a database identity, so it starts at 1. */
export const numberParams = {
  type: 'object',
  required: ['number'],
  properties: { number: { type: 'integer', minimum: 1 } },
} as const;

const detailSchema = {
  type: 'object',
  required: ['number', 'sha256', 'originalName', 'class', 'type', 'schemaId', 'status', 'attempts', 'createdAt', 'reasons', 'fields', 'pages', 'steps', 'model'],
  properties: {
    number: { type: 'integer' },
    sha256: { type: 'string' },
    originalName: { type: ['string', 'null'] },
    class: { type: 'string' },
    type: { type: ['string', 'null'] },
    schemaId: { type: ['string', 'null'] },
    status: { type: 'string' },
    attempts: { type: 'integer' },
    createdAt: { type: 'string' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        required: [...reasonShape.required, 'step', 'attempt'],
        properties: { ...reasonShape.properties, step: { type: 'string' }, attempt: { type: 'integer' } },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'kind', 'value', 'verbatim', 'page', 'offsetStart', 'offsetEnd', 'found'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          // A typed value: an ISO date, an enum member, a string, or {amount, currency}; null when the field was not found.
          value: {},
          verbatim: { type: ['string', 'null'] },
          page: { type: ['integer', 'null'] },
          offsetStart: { type: ['integer', 'null'] },
          offsetEnd: { type: ['integer', 'null'] },
          found: { type: 'boolean' },
        },
      },
    },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['page', 'width', 'height', 'source'],
        properties: { page: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, source: { type: ['string', 'null'] } },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'attempt', 'startedAt', 'finishedAt', 'outcome', 'durationMs'],
        properties: {
          step: { type: 'string' },
          attempt: { type: 'integer' },
          startedAt: { type: 'string' },
          finishedAt: { type: ['string', 'null'] },
          outcome: { type: ['string', 'null'] },
          durationMs: { type: ['integer', 'null'] },
        },
      },
    },
    model: {
      type: ['object', 'null'],
      required: ['name', 'digest', 'promptHash', 'schemaId', 'promptEvalCount', 'evalCount', 'cold'],
      properties: {
        name: { type: 'string' },
        digest: { type: 'string' },
        promptHash: { type: 'string' },
        schemaId: { type: ['string', 'null'] },
        promptEvalCount: { type: ['integer', 'null'] },
        evalCount: { type: ['integer', 'null'] },
        cold: { type: 'boolean' },
      },
    },
  },
} as const;

/** Registers the detail route on the `/api` instance. */
export function registerDocument(api: FastifyInstance, deps: DocumentsDeps): void {
  api.get<{ Params: { number: number } }>('/documents/:number', { schema: { params: numberParams, response: { 200: detailSchema } } }, async (request) => {
    const document = await documentByNumber(deps.pool, request.params.number);
    if (document === null) {
      throw new HttpError(404, 'not_found', `There is no document number ${request.params.number}.`);
    }
    const [reasons, pages, steps, calls] = await Promise.all([
      reasonsOf(deps.pool, document.id),
      pagesOf(deps.pool, document.id),
      stepRunsOf(deps.pool, document.id),
      modelCallsOf(deps.pool, document.id),
    ]);
    // The fields shown are those of the accepted extraction, or of the newest extraction when none was accepted; the model
    // identity is the one of the same call, or of the newest call of any kind for a document that never reached extraction.
    const extractions = calls.filter((call) => call.kind === 'extract');
    const shown =
      (document.accepted_extraction_id === null ? undefined : calls.find((call) => call.id === document.accepted_extraction_id)) ??
      extractions.at(-1) ??
      calls.at(-1);
    const fields = shown !== undefined && shown.kind === 'extract' ? await fieldsWithPageOf(deps.pool, shown.id) : [];
    return {
      number: document.id,
      sha256: document.sha256,
      originalName: document.original_name,
      class: document.class,
      type: document.doc_type,
      schemaId: document.schema_id,
      status: document.status,
      attempts: document.attempts,
      createdAt: document.created_at.toISOString(),
      reasons: reasons.map((row) => ({ code: row.code, params: row.params, step: row.step, attempt: row.attempt })),
      fields: fields.map((field) => ({
        name: field.name,
        kind: field.kind,
        value: field.value ?? null,
        verbatim: field.verbatim,
        page: field.page_no,
        offsetStart: field.offset_start,
        offsetEnd: field.offset_end,
        found: field.found,
      })),
      pages: pages.map((page) => ({ page: page.page_no, width: page.width_px, height: page.height_px, source: page.source })),
      steps: steps.map((run) => ({
        step: run.step,
        attempt: run.attempt,
        startedAt: run.started_at.toISOString(),
        finishedAt: run.finished_at === null ? null : run.finished_at.toISOString(),
        outcome: run.outcome,
        durationMs: run.finished_at === null ? null : Math.max(0, run.finished_at.getTime() - run.started_at.getTime()),
      })),
      model:
        shown === undefined
          ? null
          : {
              name: shown.model_name,
              digest: shown.model_digest,
              promptHash: shown.prompt_hash,
              schemaId: shown.schema_id,
              promptEvalCount: shown.prompt_eval_count,
              evalCount: shown.eval_count,
              cold: shown.cold,
            },
    };
  });
}
