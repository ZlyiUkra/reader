# Reader

Reader is a document-reading system. Documents of any format come in, a local language model recognises the
document type and extracts its fields according to a versioned type schema, fields and full content are stored in
a relational database, and a downstream product later selects documents through a query API. Everything runs in
containers: on one machine now, in the cloud or on Kubernetes later.

The current work is a local prototype on the owner's machine: a demonstration and a measuring instrument, not the
product. It was agreed by a five-archetype review board on 2026-10-17 and is being built spec-first with spec-kit.

## Dashboard

The live dashboard of the project is a page on claude.ai, updated with every change in this repository: the
spec-kit steps, the nine phases of the prototype and their tasks, the deferred items, the constitution and the
documentation servers each phase needs.

- [Reader development phases, the live dashboard](https://claude.ai/artifact/APBz6exBd7SbYGw75vgSrP)

## Where things live

- `docs/` - the decision records: round 1 (`document-ingestion-decision.md`), round 2
  (`document-reader-decision.md`) and the note on a later port to Go (`go-react-implementation.md`).
- `specs/` - spec-kit features, one folder per feature: `001-local-prototype` is the local prototype.
- `.specify/`, `.claude/` and `AGENTS.md` - the constitution, the board's handoff and briefings, the spec-kit
  templates and the agent rules. They are kept out of version control by owner decision and exist only on the
  owner's machine.
- Code arrives once the spec-kit chain reaches implementation; the plan fixes the layout.

## Stack

TypeScript on Fastify for the API and the worker, React with Vite for the browser page, PostgreSQL for the state
and the data, Ollama with a local model for recognition, a sandboxed parser container for untrusted files, all in
one Docker Compose file. A later port of the same prototype to Go is planned and documented in `docs/`.

## How the work runs

1. A change that adds contracts, services, dependencies or data schema goes through a review board round, which
   ends in a handoff file.
2. The handoff goes through the spec-kit chain: specify, clarify, plan, tasks, implement. Each step runs only
   after the owner's explicit confirmation.
3. Every phase ends with runnable acceptance checks; every simplification is named, has an undo trigger and is
   visible at runtime.
4. Numbers that were not measured on this product are estimates and are labelled as such.

## Repository

Git since 2026-10-31, branch `master`. Tracked: `README.md`, `docs/`, `specs/`, `.gitignore`. Ignored: `.claude/`,
`.specify/`, `AGENTS.md`.
