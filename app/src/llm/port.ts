import type { WireSchema } from '../registry/wire.ts';

/**
 * The in-process port through which the pipeline talks to a model, and the errors every adapter and the dispatcher raise
 * (contracts/llm-port.md; constitution VIII). The pipeline imports this file and nothing else of the LLM code, so the
 * adapters (Ollama, replay, and later Claude) can change without touching it.
 */

/** The two model calls of the pipeline (FR-015, FR-016). */
export type LlmKind = 'classify' | 'extract';

/** One model call. `documentNumber` and `class` identify whose text this is; they never reach the model. */
export type LlmRequest = {
  kind: LlmKind;
  documentNumber: number;
  /** Sensitivity class name; the dispatcher checks `may_leave` before any adapter runs. */
  class: string;
  /** Fixed instructions. */
  system: string;
  /** The page texts and the task, built from the registry. */
  user: string;
  /** The JSON Schema the reply must satisfy. */
  wireSchema: WireSchema;
  /** Generation cap, from the thresholds. */
  numPredict: number;
};

/** Token counts of one call; null when the server did not report them. */
export type LlmCounts = { promptEval: number | null; eval: number | null };

/** Durations of one call in nanoseconds, as the server reports them; null when absent. */
export type LlmDurationsNs = { load: number | null; promptEval: number | null; eval: number | null; total: number | null };

/**
 * What a call returns. `json` is the parsed and schema-validated reply, except when `doneReason` is `length`: the
 * generation hit its cap, the reply is cut off and `json` is null; the pipeline maps that to REJECTED TOO_LARGE with the
 * cap as the breached limit and does not retry (FR-022, C7). A reply that cannot be made valid is not returned: the adapter
 * throws `LlmAdapterError`, so a response never carries both a value and an error.
 */
export type LlmResponse = {
  json: unknown;
  /** The request body as sent (with the endpoint and the fallback used) and the reply body as received. */
  raw: { request: object; response: object };
  modelName: string;
  modelDigest: string;
  doneReason: string | null;
  counts: LlmCounts;
  durationsNs: LlmDurationsNs;
  /** True when the call paid for loading the model, so its timings are not those of a warm model (C7). */
  cold: boolean;
};

/** Whether the model can take a call; `digest` is the pinned digest it was checked against, null while missing. */
export type LlmReadiness = { state: 'missing' | 'ready'; digest: string | null };

/** The interface of contracts/llm-port.md. */
export type LlmPort = {
  readiness(): Promise<LlmReadiness>;
  call(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
};

/**
 * A port plus what the dispatcher needs to know about its implementation: a name for logs and `local`, whether the model
 * runs on this machine. The dispatcher never sends a class that may not leave to an adapter that is not local.
 */
export type LlmAdapter = LlmPort & { name: string; local: boolean };

/** The dispatcher refused to send a request whose class may not leave to an adapter that is not local (constitution IV, FR-007). */
export class LocalOnlyViolation extends Error {
  className: string;
  adapter: string;
  constructor(className: string, adapter: string, reason: string) {
    super(`Class "${className}" ${reason}, so it is not sent to the non-local adapter "${adapter}".`);
    this.name = 'LocalOnlyViolation';
    this.className = className;
    this.adapter = adapter;
  }
}

/**
 * The prompt does not fit the context window next to the generation cap. Carries the numbers the TOO_LARGE reason prints
 * (`limit`, `actual`, `max`) and is mapped to REJECTED without retry (FR-022).
 */
export class PromptOverBudget extends Error {
  estimatedTokens: number;
  availableTokens: number;
  numCtx: number;
  numPredict: number;
  constructor(estimatedTokens: number, availableTokens: number, numCtx: number, numPredict: number) {
    super(`The prompt is about ${estimatedTokens} tokens; the context of ${numCtx} tokens leaves ${availableTokens} after ${numPredict} for the reply.`);
    this.name = 'PromptOverBudget';
    this.estimatedTokens = estimatedTokens;
    this.availableTokens = availableTokens;
    this.numCtx = numCtx;
    this.numPredict = numPredict;
  }
}

/** Why an adapter could not give a usable reply. The pipeline maps every kind to INTERNAL_ERROR, which is retried (C6). */
export type LlmFailureKind = 'transport' | 'timeout' | 'http' | 'invalid-reply' | 'recording';

/**
 * A call that failed in the adapter: the server did not answer, answered with an error, took too long, or answered
 * something that stayed invalid after the fallbacks. `details` holds one short, content-free line per attempt, safe for logs.
 */
export class LlmAdapterError extends Error {
  kind: LlmFailureKind;
  details: string[];
  constructor(kind: LlmFailureKind, message: string, details: string[] = []) {
    super(message);
    this.name = 'LlmAdapterError';
    this.kind = kind;
    this.details = details;
  }
}
