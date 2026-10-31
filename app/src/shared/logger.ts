/**
 * The two logging calls the modules outside the server need, in the shape of Fastify's logger (pino): fields first, then
 * the message. Modules take this type and not the Fastify instance, so the worker and the model adapters stay free of
 * the framework (AGENTS.md: the worker takes its own dependencies). Fields carry ids, codes and timings only, never page
 * text, field values or raw model replies.
 */
export type Logger = {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
};
