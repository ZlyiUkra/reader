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
- `app/` - the API, the worker, the eval command and the browser page; `parser/` - the sandbox and the fixtures
  generator; `schemas/` - one JSON Schema per document type; `config/` - classes, model, reasons and thresholds;
  `db/` - the database schema; `compose.yaml` - the whole stack.
- `inbox/` and `results/` - the folder documents arrive in and the eval reports; only their `.gitkeep` is tracked.

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

## Measurement journal

Every run of the evaluation (`docker compose run --rm app node src/eval.ts`) prints its figures, writes one JSON
report into `results/` and exits non-zero below the thresholds. The report is the source of the numbers here; the
`results/` folder is not tracked, so each row names its report file. Seconds per page are parse plus model time;
the cold figure is the first document after the model was unloaded. A row is added for every run that follows a
change of the model, the prompt, a schema or the code. The thresholds are provisional until measured, and a verdict
is not a tier decision.

| Date | What changed | Model digest | Schemas | Field match | False accepts | Seconds per page | Tokens per document |
|------|--------------|--------------|---------|-------------|---------------|------------------|---------------------|
| 2026-11-01 | First measurement: 11 fixtures, `qwen3.5:4b`, prompt `925239a4e70c`, registry `951b22f9e1b5`, all thresholds provisional | `d8b0f5e9760c` | `invoice.v1`, `act.v1`, `contract.v1` | 89.6% (120 of 134); required fields of the ACCEPTED fixtures 92.6% (63 of 68) | 7 values in 3 documents; verdict FAIL | warm 1.11 + 7.02 = 8.13 (ceiling 60); cold 1.98 + 10.25 | 1457 (ceiling 6000) |

- Row 1: `results/eval-20261101-033023-d8b0f5e9760c.json`. A first run of the same code on the same fixtures
  (`results/eval-20261101-032705-d8b0f5e9760c.json`) gave the same field figures; the model was already loaded, so it
  has no cold figure.
- Row 1, what the 7 false accepts are: three values with stray OCR letters in front (the act number and its contract
  reference in `act-1.png`, the contract number in `contract-1.svg`) and four sentence values with a trailing full
  stop (subject and payment terms of `contract-1.svg` and `contract-2.docx`).
- Row 1, characters per token measured over 21 calls: 2.843, against the 3 in the thresholds file.

## Repository

Git since 2026-10-31, branch `main`. Tracked: `README.md`, `docs/`, `specs/`, `.gitignore`. Ignored: `.claude/`,
`.specify/`, `AGENTS.md`.
