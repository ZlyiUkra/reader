import fastifyMultipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http-error.ts';
import { BlobTooLargeError } from '../intake/store.ts';
import { generatorHashes, takeBlob } from '../intake/take.ts';
import type { IntakeDeps } from '../intake/take.ts';

/**
 * `POST /api/documents` (contracts/api.md, FR-003, FR-004): one file in the multipart field `file`, streamed to the blob
 * store under its hash with the size limit of the thresholds file. A new hash answers `201` with the new number; a known
 * hash answers `200` with `DUPLICATE` and the original's number and stores nothing; a file over the limit answers `413`.
 * The multipart plugin is used as the README says to stream: `saveRequestFiles` is never called, nothing is buffered, and
 * the original name is kept as a description only.
 */

const documentSchema = {
  type: 'object',
  required: ['number', 'sha256', 'class', 'status'],
  properties: { number: { type: 'integer' }, sha256: { type: 'string' }, class: { type: 'string' }, status: { const: 'RECEIVED' } },
} as const;

const duplicateSchema = {
  type: 'object',
  required: ['code', 'originalNumber', 'sha256'],
  properties: { code: { const: 'DUPLICATE' }, originalNumber: { type: 'integer' }, sha256: { type: 'string' } },
} as const;

/** The code the multipart plugin gives to a file that crossed `limits.fileSize`. */
const multipartTooLargeCode = 'FST_REQ_FILE_TOO_LARGE';

/** Registers the multipart plugin with the limits of the thresholds file and the upload route on the `/api` instance. */
export async function registerUpload(api: FastifyInstance, deps: IntakeDeps): Promise<void> {
  // One byte more than the cap: the plugin cuts the stream at its limit, and a cut stream that ends at exactly the cap would
  // look like a complete file. With the extra byte the counter in the blob store always sees "over the cap" for a file that
  // is, and it is the one authority on the size, however the plugin signals the cut.
  await api.register(fastifyMultipart, { limits: { fileSize: deps.maxBytes + 1, files: 1, fields: 0, parts: 1 } });
  api.post('/documents', { schema: { response: { 200: duplicateSchema, 201: documentSchema } } }, async (request, reply) => {
    const part = await request.file();
    if (part === undefined || part.fieldname !== 'file') {
      throw new HttpError(400, 'bad_request', 'The request needs one file in the multipart field "file".');
    }
    const generated = await generatorHashes(deps.inboxDir, deps.logger);
    try {
      const outcome = await takeBlob(deps, part.file, { originalName: part.filename === '' ? null : part.filename, originalPath: null }, generated);
      if (outcome.kind === 'duplicate') {
        return { code: 'DUPLICATE', originalNumber: outcome.originalNumber, sha256: outcome.sha256 };
      }
      return reply.code(201).send({ number: outcome.number, sha256: outcome.sha256, class: outcome.documentClass, status: 'RECEIVED' });
    } catch (error) {
      if (error instanceof BlobTooLargeError || (error as { code?: string }).code === multipartTooLargeCode) {
        throw new HttpError(413, 'too_large', `The file is larger than ${deps.maxBytes} bytes.`);
      }
      throw error;
    }
  });
}
