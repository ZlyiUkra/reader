# Contract: the LLM port and its adapters

The pipeline talks to a model only through this in-process port (constitution VIII, round 2 decision 9). Two
adapters exist in the prototype: `ollama` (connected) and `replay` (tests, acceptance check 9). The Claude adapter is
a third implementation of the same interface, not written now.

## Interface (TypeScript, erasable syntax only)

```ts
type LlmRequest = {
  kind: "classify" | "extract";
  documentNumber: number;
  class: string;                 // sensitivity class name; the dispatcher checks may_leave before any adapter runs
  system: string;                // fixed instructions
  user: string;                  // the page texts and the task, built from the registry
  wireSchema: object;            // the JSON Schema the response must satisfy
  numPredict: number;            // from thresholds
};

type LlmResponse = {
  json: unknown;                 // parsed and ajv-validated against wireSchema, or an error (never both)
  raw: { request: object; response: object };
  modelName: string;
  modelDigest: string;
  doneReason: string | null;
  counts: { promptEval: number | null; eval: number | null };
  durationsNs: { load: number | null; promptEval: number | null; eval: number | null; total: number | null };
  cold: boolean;
};

type LlmPort = {
  readiness(): Promise<{ state: "missing" | "ready"; digest: string | null }>;
  call(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
};
```

The dispatcher wraps the chosen adapter: it refuses a request whose class may not leave when the adapter is not
local (`LocalOnlyViolation`, never sent), checks the prompt against the context budget
(`chars_per_token`, `num_ctx`) and raises `PromptOverBudget` (mapped to `TOO_LARGE`), and serialises calls so only one
runs at a time (C7).

## Ollama adapter

- `POST /api/chat` with `model`, `messages` (system, user), `think: false`, `format: <wireSchema>`, `stream: false`,
  `keep_alive: thresholds.model.keep_alive`, `options: { num_predict }`. The context is the server-wide
  `OLLAMA_CONTEXT_LENGTH` (C7); the adapter sends no `num_ctx`.
- Fallback 1 on an invalid or empty structured reply: the same request on `/api/generate` with `prompt` built from
  the messages. Fallback 2: `think: true` with `format` (C4). The fallback used is recorded in `raw.request`.
- Every reply is parsed and validated against the wire schema, whatever the server claims (FR-039). An invalid
  reply after the fallbacks is an adapter error mapped to `INTERNAL_ERROR`; `done_reason: "length"` is returned as
  such and mapped by the pipeline to REJECTED `TOO_LARGE` with the generation cap (`num_predict`) as the breached
  limit, without retry (FR-022, C7).
- Readiness: `GET /api/tags` lists the configured model name with the pinned digest, then one warm-up call with a
  trivial wire schema succeeds, then `GET /api/ps` shows the loaded model with `context_length` equal to
  `thresholds.model.num_ctx` (FR-037). The server-wide `OLLAMA_CONTEXT_LENGTH` and the thresholds file must agree; a
  mismatch keeps the model `missing` and logs WARN with both numbers. Client timeout:
  `thresholds.model.client_timeout_s`.
- `cold` is true when `load_duration` exceeds the threshold `model.cold_load_ns` or the warm-up had to load the model.

## Replay adapter

Reads `raw.response` from stored extractions (a fixtures folder of recorded responses keyed by
`sha256(request.user + wireSchema)`), returns them with `adapter: "replay"`. A request without a recording fails the
test. Recordings are refreshed by a maintenance command when the prompt or a schema changes; they never contain
real documents.

## Contract test (acceptance check 1)

`test/ollama-contract.test.ts`: five calls with the invoice wire schema on a fixed page text; each reply parses,
validates, has empty `thinking` in the message and `done_reason: "stop"`. Runs only with the model service up; it
is the one test the GPU-free suite skips.
