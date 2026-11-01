import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path/posix';
import type { FastifyInstance } from 'fastify';
import { documentByNumber, pageBlobKeyOf } from '../db/queries.ts';
import { HttpError } from '../http-error.ts';
import { numberParams } from './document.ts';
import type { DocumentsDeps } from './documents.ts';

/**
 * `GET /api/documents/{number}/pages/{page}.png` (contracts/api.md, FR-054, C15): the stored preview of one page, as
 * `image/png` with `nosniff` and a private cache. This is the only file the app serves from the blob store. There is no
 * route for an original, and no route takes a path: the key is read from the database by document number and page number,
 * and the file is opened without following a link and only if it is a regular file inside the blob root. The width of a
 * preview was capped when the parser rendered it (`parser.render_width_px`), so nothing is resized here.
 */

/** How long the browser may keep a preview; a page of a stored document never changes. */
const cacheControl = 'private, max-age=3600';

/** Registers the page preview route on the `/api` instance. */
export function registerPages(api: FastifyInstance, deps: DocumentsDeps): void {
  api.get<{ Params: { number: number; page: number } }>(
    '/documents/:number/pages/:page(^\\d+).png',
    { schema: { params: { ...numberParams, required: ['number', 'page'], properties: { ...numberParams.properties, page: { type: 'integer', minimum: 1 } } } } },
    async (request, reply) => {
      const notFound = new HttpError(404, 'not_found', 'There is no such page.');
      const document = await documentByNumber(deps.pool, request.params.number);
      if (document === null) {
        throw notFound;
      }
      const key = await pageBlobKeyOf(deps.pool, document.id, request.params.page);
      const file = key === null ? null : path.join(deps.blobRoot, key);
      if (file === null || !file.startsWith(`${deps.blobRoot}/`)) {
        throw notFound;
      }
      let handle;
      try {
        handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        throw notFound;
      }
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        throw notFound;
      }
      return reply
        .header('content-type', 'image/png')
        .header('content-length', stats.size)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', cacheControl)
        .send(handle.createReadStream());
    },
  );
}
