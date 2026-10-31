import type { FastifyInstance } from 'fastify';
import { listInbox, readInbox } from '../intake/inbox.ts';
import type { IntakeDeps } from '../intake/take.ts';

/**
 * `GET /api/inbox` and `POST /api/inbox/read` (contracts/api.md, FR-001, FR-003, FR-005). The first lists the folder
 * without hashing anything; the second hashes and takes every listed file in, and answers which were taken, which were
 * duplicates of a known document and which were skipped and why. The folder is read only when the owner asks.
 */

const listingSchema = {
  type: 'object',
  required: ['path', 'files'],
  properties: {
    path: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'sizeBytes', 'modifiedAt'],
        properties: { name: { type: 'string' }, sizeBytes: { type: 'integer' }, modifiedAt: { type: 'string' } },
      },
    },
  },
} as const;

const readSchema = {
  type: 'object',
  required: ['taken', 'duplicates', 'skipped'],
  properties: {
    taken: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'name', 'sha256', 'class'],
        properties: { number: { type: 'integer' }, name: { type: 'string' }, sha256: { type: 'string' }, class: { type: 'string' } },
      },
    },
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'sha256', 'originalNumber', 'code'],
        properties: { name: { type: 'string' }, sha256: { type: 'string' }, originalNumber: { type: 'integer' }, code: { const: 'DUPLICATE' } },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'reason'],
        properties: { name: { type: 'string' }, reason: { enum: ['not_regular', 'too_large', 'unreadable'] } },
      },
    },
  },
} as const;

/** Registers the two routes on the `/api` instance. */
export function registerInbox(api: FastifyInstance, deps: IntakeDeps): void {
  api.get('/inbox', { schema: { response: { 200: listingSchema } } }, async () => listInbox(deps.inboxDir));
  api.post('/inbox/read', { schema: { response: { 200: readSchema } } }, async () => readInbox(deps));
}
