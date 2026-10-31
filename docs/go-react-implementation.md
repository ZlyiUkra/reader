# Document reader: Go + React implementation

Status: in progress as a learning project; no code in this folder
Date: 2026-10-28
Origin: owner decision of 2026-10-27/28 to use this prototype as the main project of the Go full-stack learning line.

The local prototype agreed by the board on 2026-10-17 ([handoff](../.specify/consilium/2026-10-17-local-prototype.md), constitution 1.0.0, conditions C1–C17, acceptance checks 1–14) gets an implementation with the backend in **Go** and the front in **React + Vite**. The owner decision "TypeScript, Fastify, React + Vite" in the handoff is not revised by this note: it records a second implementation of the same prototype, not a change of the board's verdict.

## Where it lives

- Code: repository `goal2learn` (`~/Projects/goal2learn`), folder `reader/` — one Go module (`cmd/`, `internal/`, `migrations/`, `schemas/`, `deploy/compose.yaml`), the front in `reader/web/`.
- Plan: repository `docfactory`, file `instances/go/LEARNING.md` (the Go learning plan), with the documentation servers of each day.
- This folder stays the source of the decisions: the two decision records in `docs/`, the handoff and the constitution in `.specify/`.

## Phases

| Go plan | Prototype phase | What |
|---------|-----------------|------|
| Phase 1 | 0 | skeleton and networks: `net/http`, image, Compose with five services, Postgres role without superuser |
| Phase 2 | 1–2 | model and contract (Ollama, Go client, LLM port, contract test); schema registry and reasons |
| Phase 3 | 3–4 | synthetic fixtures; sandbox and parsing (`os/exec`, process groups, OCR, `os.Root`) |
| Phase 4 | 5 | intake and queue in Postgres (`FOR UPDATE SKIP LOCKED`, leases, workers) |
| Phase 5 | 6–7 | recognition and checks; the React front |
| Phase 6 | 8 | eval command, GPU-free tests, race detector, linters, profiling |
| Phase 7 | deferred table | reviewer login and form, serving API (OpenAPI), cloud adapter, repair agent, gVisor, Kubernetes, model in image, migrations as a Job |
| Phase 8 | — | the front moves from Vite to Next.js (`reader/next/`): server components over the Go API, tokens only in server-side HttpOnly cookies, server actions, streamed uploads, a Next.js pod in the cluster, an end-to-end Playwright test |

Each phase ends with the prototype's acceptance checks for its phases.

## Deviations from the handoff

- **Stack.** Go instead of TypeScript and Fastify; `pgx` and `sqlc` instead of `pg`; `github.com/santhosh-tekuri/jsonschema/v6` instead of ajv; `mime/multipart` streaming instead of `@fastify/multipart`; static files embedded in the binary instead of `@fastify/static`.
- **Initial schema.** The first `goose` migration, embedded in the binary, replaces the initial SQL; the `schema_version` check reads the goose version table. Migrations as such stay deferred in the sense of the handoff: no migration runs on app start.
- **Unchanged.** Ollama with `qwen3.5:4b`, the closed list of 15 reasons with 11 emitted, the status function, sensitivity classes and egress rule, the duplicate and lease decisions, the fixture set (6 ACCEPTED, 3 NEEDS_REVIEW with `MISSING_REQUIRED_FIELD`, 2 bad), the threshold written before the first eval run.
