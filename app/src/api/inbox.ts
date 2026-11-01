import type { FastifyInstance } from 'fastify';
import { createHashMemory, listInbox, readInbox } from '../intake/inbox.ts';
import type { IntakeDeps } from '../intake/take.ts';

/**
 * `GET /api/inbox` and `POST /api/inbox/read` (contracts/api.md, FR-001, FR-003, FR-005, FR-061). The first lists the
 * folder with the state of each file, hashing a file only the first time it sees it at a given size and modified time; the
 * second hashes and takes every listed file in, and answers which were taken, which were duplicates of a known document and
 * which were skipped and why. Files are taken in only when the owner asks.
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
        required: ['name', 'sizeBytes', 'modifiedAt', 'state'],
        properties: {
          name: { type: 'string' },
          sizeBytes: { type: 'integer' },
          modifiedAt: { type: 'string' },
          state: {
            type: 'object',
            required: ['kind'],
            properties: { kind: { enum: ['unread', 'document', 'skipped'] }, number: { type: 'integer' }, reason: { enum: ['too_large', 'unreadable'] } },
          },
        },
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
  const memory = createHashMemory();
  api.get('/inbox', { schema: { response: { 200: listingSchema } } }, async () => listInbox(deps, memory));
  api.post('/inbox/read', { schema: { response: { 200: readSchema } } }, async () => readInbox(deps));
}
