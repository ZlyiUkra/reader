import { readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * What the server answers for a path it does not know (FR-067, contracts/api.md). The page is a single-page app that
 * lives at the root, so a browser that asks for any other path wants the page's own not-found view, not a JSON error
 * it cannot render: that request gets the page itself with the status 404 and a base address of `/`, because the page's
 * files are linked relatively and a nested path such as `/a/b/c` would otherwise look for them under `/a/b/`. Every other
 * unknown path, and everything under `/api`, keeps the JSON error that the clients of the API read.
 */

/** The JSON error of an unknown resource. */
const notFoundBody = { error: { code: 'not_found', message: 'No such resource.' } };

/** True when the request is a `GET` for a path outside `/api` whose Accept header lists `text/html`: a browser asking for a page. */
function asksForPage(request: FastifyRequest): boolean {
  const pathname = request.url.split('?')[0] ?? '';
  if (request.method !== 'GET' || pathname === '/api' || pathname.startsWith('/api/')) {
    return false;
  }
  return (request.headers.accept ?? '').split(',').some((type) => type.trim().toLowerCase().startsWith('text/html'));
}

/**
 * The not-found handler of the server: the built page with the status 404 for a browser's request, else the JSON error.
 * `webRoot` is the folder of the built page, or null when the server runs without one (the tests); a page that cannot be
 * read is the JSON error too, so a missing build never turns into a second failure.
 */
export function createNotFoundHandler(webRoot: string | null): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    if (webRoot !== null && asksForPage(request)) {
      const page = await readFile(path.join(webRoot, 'index.html'), 'utf8').catch(() => null);
      if (page !== null) {
        return reply.code(404).type('text/html; charset=utf-8').send(page.replace(/<head[^>]*>/i, (head) => `${head}<base href="/">`));
      }
    }
    return reply.code(404).send(notFoundBody);
  };
}
