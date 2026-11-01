import type { FastifyInstance } from 'fastify';
import { documentByNumber, rawCallsOf } from '../db/queries.ts';
import { HttpError } from '../http-error.ts';
import { numberParams } from './document.ts';
import type { DocumentsDeps } from './documents.ts';

/**
 * `GET /api/documents/{number}/raw` (contracts/api.md, FR-053a): the raw request and response of every model call of one
 * document, exactly as stored. It answers for one document at a time and is the only route that carries them: the list and
 * the detail view never do (FR-054), so a poll of the table cannot move model data. The page fetches it only when the owner
 * opens the collapsed block and shows it as plain text.
 */

const rawSchema = {
  type: 'object',
  required: ['number', 'extractions'],
  properties: {
    number: { type: 'integer' },
    extractions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'attempt', 'adapter', 'modelDigest', 'doneReason', 'rawRequest', 'rawResponse', 'createdAt'],
        properties: {
          id: { type: 'integer' },
          kind: { enum: ['classify', 'extract'] },
          attempt: { type: 'integer' },
          adapter: { type: 'string' },
          modelDigest: { type: 'string' },
          doneReason: { type: ['string', 'null'] },
          rawRequest: { type: 'object', additionalProperties: true },
          rawResponse: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Registers the raw route on the `/api` instance. */
export function registerRaw(api: FastifyInstance, deps: DocumentsDeps): void {
  api.get<{ Params: { number: number } }>('/documents/:number/raw', { schema: { params: numberParams, response: { 200: rawSchema } } }, async (request) => {
    const document = await documentByNumber(deps.pool, request.params.number);
    if (document === null) {
      throw new HttpError(404, 'not_found', `There is no document number ${request.params.number}.`);
    }
    const calls = await rawCallsOf(deps.pool, document.id);
    return {
      number: document.id,
      extractions: calls.map((call) => ({
        id: call.id,
        kind: call.kind,
        attempt: call.attempt,
        adapter: call.adapter,
        modelDigest: call.model_digest,
        doneReason: call.done_reason,
        rawRequest: call.raw_request,
        rawResponse: call.raw_response,
        createdAt: call.created_at.toISOString(),
      })),
    };
  });
}
