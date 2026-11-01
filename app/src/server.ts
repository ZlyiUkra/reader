import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { registerDocument } from './api/document.ts';
import { registerDocuments } from './api/documents.ts';
import { registerHealth } from './api/health.ts';
import type { HealthDeps } from './api/health.ts';
import { registerInbox } from './api/inbox.ts';
import { registerMeta } from './api/meta.ts';
import type { MetaDeps } from './api/meta.ts';
import { registerPages } from './api/pages.ts';
import { registerRaw } from './api/raw.ts';
import { registerUpload } from './api/upload.ts';
import { HttpError } from './http-error.ts';
import type { IntakeDeps } from './intake/take.ts';

/**
 * The one Fastify instance: the JSON API under `/api` and the built front, with the rules that keep the page on the
 * loopback address (C15, FR-056, research R11, acceptance check 13). Everything the server needs is passed in, so the
 * tests build it without a database or a model and `main.ts` is the only place that wires the real ones.
 */

export { HttpError };

/** What `buildServer` needs. */
export type ServerDeps = HealthDeps &
  MetaDeps & {
    /** The inbox, upload and document routes; absent in tests that need neither a folder nor a database. */
    intake?: IntakeDeps;
    /** The port the browser uses, which is the one the `Host` and `Origin` of every request must carry. */
    publicPort: number;
    /** Folder of the built front, or `null` to serve the API only (tests). */
    webRoot: string | null;
    logger: boolean;
  };

/** The hosts and origins a request may carry: the loopback address and `localhost` on the public port, over plain HTTP. */
export function allowedHosts(publicPort: number): { hosts: string[]; origins: string[] } {
  const hosts = [`127.0.0.1:${publicPort}`, `localhost:${publicPort}`];
  return { hosts, origins: hosts.map((host) => `http://${host}`) };
}

/** Methods that change nothing; every other method is state-changing and needs the marker header as well. */
const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Builds the server. The `onRequest` hook rejects, before any handler runs and with no side effect, a foreign `Host`
 * (`421`, which defeats DNS rebinding on the loopback address), a state-changing request without the page's own
 * `Origin` and the header `X-Reader-Request: 1` (`403`), and a read with a foreign `Origin` (`403`). No CORS plugin is
 * registered and no `Access-Control-*` header is ever sent: a page on another origin can neither read a response nor
 * send the custom header without a preflight that is refused. Every error leaves in one shape, and a server error says
 * nothing about its cause (OWASP ASVS 16.5.1); the cause goes to the log.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger });
  const { hosts, origins } = allowedHosts(deps.publicPort);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'self'"], imgSrc: ["'self'"], frameAncestors: ["'none'"] },
    },
  });

  app.addHook('onRequest', async (request) => {
    const { host, origin } = request.headers;
    if (host === undefined || !hosts.includes(host)) {
      throw new HttpError(421, 'misdirected_request', 'The Host header is not one this server answers to.');
    }
    if (!safeMethods.includes(request.method)) {
      if (origin === undefined || !origins.includes(origin) || request.headers['x-reader-request'] !== '1') {
        throw new HttpError(403, 'forbidden', 'A state-changing request needs the page\'s own Origin and the X-Reader-Request header.');
      }
    } else if (origin !== undefined && !origins.includes(origin)) {
      throw new HttpError(403, 'forbidden', 'The Origin header is not the page\'s own.');
    }
  });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
    }
    const code = error instanceof HttpError ? error.code : statusCode === 404 ? 'not_found' : statusCode < 500 ? 'bad_request' : 'internal_error';
    return reply.code(statusCode).send({ error: { code, message: statusCode >= 500 ? 'Internal error.' : error.message } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'No such resource.' } }));

  await app.register(
    async (api) => {
      registerHealth(api, deps);
      registerMeta(api, deps);
      if (deps.intake !== undefined) {
        registerInbox(api, deps.intake);
        await registerUpload(api, deps.intake);
        registerDocuments(api, deps.intake);
        registerDocument(api, deps.intake);
        registerRaw(api, deps.intake);
        registerPages(api, deps.intake);
      }
    },
    { prefix: '/api' },
  );

  if (deps.webRoot !== null) {
    await app.register(fastifyStatic, { root: deps.webRoot, wildcard: false });
  }
  return app;
}
