import type { FastifyInstance } from 'fastify';
import { constants } from '../constants.ts';
import { todoList } from '../config/todo.ts';

/**
 * `GET /api/health` (contracts/api.md, FR-037, FR-052, FR-065): the state of the database, the model and the parser, the
 * sandbox runtime and the list of named simplifications that the page header counts and the page lists. It never throws: a database that does not answer is
 * reported as `down`, because the page needs the answer most when something is wrong.
 */

/** What the model service reports (contracts/llm-port.md, readiness). */
export type ModelReadiness = {
  state: 'missing' | 'ready';
  digest: string | null;
};

/** What the health route reads from outside the module. */
export type HealthDeps = {
  /** True when the database answers a trivial query. */
  checkDb: () => Promise<boolean>;
  /** The readiness of the model; until the Ollama adapter is wired in (T067) it reports `missing`. */
  readiness: () => Promise<ModelReadiness>;
  /** True when the parser's socket accepts a connection; it never waits long for a parser that is not there. */
  checkParser: () => Promise<boolean>;
  /** The parser's runtime, from `READER_SANDBOX_RUNTIME`. */
  sandbox: string;
};

const simplificationSchema = {
  type: 'object',
  required: ['id', 'uk', 'en', 'trigger'],
  properties: {
    id: { type: 'string' },
    uk: { type: 'string' },
    en: { type: 'string' },
    trigger: { type: 'object', required: ['uk', 'en'], properties: { uk: { type: 'string' }, en: { type: 'string' } } },
  },
} as const;

/** Registers the route on the `/api` instance. */
export function registerHealth(api: FastifyInstance, deps: HealthDeps): void {
  api.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['db', 'model', 'modelDigest', 'parser', 'sandbox', 'schemaVersion', 'todo'],
            properties: {
              db: { enum: ['ok', 'down'] },
              model: { enum: ['missing', 'ready'] },
              modelDigest: { type: ['string', 'null'] },
              parser: { enum: ['ok', 'down'] },
              sandbox: { type: 'string' },
              schemaVersion: { type: 'integer' },
              todo: { type: 'array', items: simplificationSchema },
            },
          },
        },
      },
    },
    async () => {
      const [dbUp, model, parserUp] = await Promise.all([deps.checkDb(), deps.readiness(), deps.checkParser()]);
      return {
        db: dbUp ? 'ok' : 'down',
        model: model.state,
        modelDigest: model.digest,
        parser: parserUp ? 'ok' : 'down',
        sandbox: deps.sandbox,
        schemaVersion: constants.schemaVersion,
        todo: todoList,
      };
    },
  );
}
