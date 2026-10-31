# Implementation Plan: Local Prototype of the Document Reader

**Branch**: `main` (feature directory `specs/001-local-prototype`) | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-local-prototype/spec.md`

## Summary

Build the local Docker Compose prototype agreed by the board on 2026-10-17: documents from an inbox folder or a
browser upload go through a sandboxed parser, a local model (Ollama, `qwen3.5:4b`) classifies and extracts fields
according to versioned type schemas, the pipeline locates each value's verbatim fragment in the stored page text
and runs deterministic checks, the status table in PostgreSQL is the only record of state, a React page shows the
folder, the documents and the evidence, and an evaluation command judges the run against the threshold written in
the spec. Technical approach: one Node 24 process on Fastify serves the API, runs the single worker and the static
front; a second, network-less container parses untrusted bytes behind a Unix socket; everything is pinned to exact
versions and digests; tests run without the GPU through a replay adapter of the LLM port.

## Technical Context

**Language/Version**: TypeScript on Node 24, run by Node's type stripping without a build step for the backend
(`erasableSyntaxOnly`, `verbatimModuleSyntax`, `.ts` import specifiers; `tsc --noEmit` is the type check). Exact
versions of Node, TypeScript and every package are pinned in [research.md](research.md), R1 and R2.

**Primary Dependencies**: Fastify 5 with `@fastify/multipart` (10.1.1 or later), `@fastify/static`,
`@fastify/helmet`; `pg` 8; `ajv` 8 with `ajv-formats`; React 19 with `react-dom`; Vite with `@vitejs/plugin-react`.
Dev only: `typescript`, `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`. The parser package uses Node
built-ins only. No ORM, no router, no state library, no i18n library, no front test framework (R3, R9, R10).

**Storage**: PostgreSQL 17 from the `pgvector/pgvector` image (embeddings stay deferred; the extension is not
created); named volumes for the database, the model weights, the blobs (originals and page previews), the parser
jobs and the evaluation reports; the inbox is a read-only bind mount.

**Testing**: `node:test` and `node:assert/strict`; a replay adapter of the LLM port and golden parser outputs make
the pipeline tests GPU-free (acceptance check 9); snapshot files for the wire schemas; one contract test against
the live model (check 1); the evaluation command (check 14). Front: `tsc --noEmit` and the acceptance checks; the
page's pure logic (reason rendering, dictionary completeness) is tested in `node:test` as plain modules (R10).

**Target Platform**: Linux containers under Docker Engine in WSL2 on the owner's machine; one NVIDIA GPU with
8 GB (Turing) through the NVIDIA Container Toolkit; the browser on the same machine at `127.0.0.1:3000`.

**Project Type**: web service with a worker and a static single-page front, plus a sandboxed parser service and a
one-off fixtures generator, in one repository with two Node packages (`app/`, `parser/`) and three images.

**Performance Goals**: the eleven fixtures reach terminal statuses within the run bound of the thresholds file
(provisional 15 minutes warm); at most 60 seconds per page warm and 6,000 tokens per document (spec, Measurement
Contract). Every figure is a provisional estimate until the evaluation measures it (constitution I).

**Constraints**: UI on loopback only; database and model ports never published; parser without network, read-only
root, non-root, dropped capabilities, numeric limits; one LLM call at a time and never inside a row lock; data
append-only; no migrations (schema version check plus reset); single worker with boot requeue; synthetic documents
only; nothing personal in version control.

**Scale/Scope**: one user; 11 documents of 3 types across 9 formats, about 30 pages; 3 type schemas; 15 reason
codes; 3 browser views; 14 acceptance checks.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How the plan satisfies it | Gate |
| --- | --- | --- |
| I. Measure first | Metric, threshold and ceiling are written in the spec; `config/thresholds.json` marks every value provisional; the eval report records them; every estimate in this plan is labelled | PASS |
| II. Schema registry is the single source | `schemas/*.json` with `x-reader` labels and checks; wire schema, classify enum, prompt, labels, checks and fixtures derive from it ([contracts/type-schema.md](contracts/type-schema.md)) | PASS |
| III. Status table is the single source of truth | `documents.status` plus `FOR UPDATE SKIP LOCKED` leases; outputs and state commit together; append-only tables ([data-model.md](data-model.md)); the parser channel is a socket, not a queue | PASS |
| IV. Sensitivity class before any model call | `class NOT NULL` set at intake by one rule; `config/classes.json` with `may_leave`; app exits if a class lacks it; the dispatcher refuses non-local adapters | PASS |
| V. One reading per page, provenance by the pipeline | `page_texts` one row per reading; fragment search with pinned normalisation computes offsets; model value kept only in `raw_response` | PASS |
| VI. No auto-accept without evidence and checks | `fields.found` generated from offsets; checks as rules in the registry; `config/reasons.json` with templates; one `status()` function with a table test | PASS |
| VII. Untrusted files only in the sandbox | `parser` service with `network_mode: none`, read-only root, non-root, `cap_drop ALL`; app reads outputs per [contracts/parser.md](contracts/parser.md) | PASS |
| VIII. Model has no database access | The LLM port returns data only; the pipeline validates with ajv and locates evidence before any write; no tools | PASS |
| IX. Features wait for a consumer or a measurement | No ORM, no router, no state or i18n library, no second worker, no embeddings; each has no consumer yet (R3, R9) | PASS |
| X. Personal data stays out of version control | Fixtures synthetic with fictional companies; `inbox/`, `results/`, `.env` ignored; no real document anywhere | PASS |
| XI. Exact pins and contract tests | Every image by tag and digest, every package by exact version (research R1, R2, R4); Ollama contract test before trust | PASS |
| XII. Named simplifications | Eleven deferred items as startup WARN and `/api/health` `todo`; listed in Complexity Tracking with triggers | PASS |

Security and Data Constraints of the constitution: internal ports unpublished; sha256 identity; model by tag and
digest from the official source; LibreOffice without Java; application role not a superuser; gVisor deferred as a
named simplification. All met by [contracts/compose.md](contracts/compose.md) and the data model.

Development Workflow: this feature came through a consilium round (handoff of 2026-10-17); acceptance checks are
commands with expected results ([quickstart.md](quickstart.md)); GPU-free tests cover the pipeline.

**Pre-research gate: PASS. Post-design gate (after Phase 1): PASS**, no unjustified violation; the justified ones are
the named simplifications below.

## Project Structure

### Documentation (this feature)

```text
specs/001-local-prototype/
├── plan.md              # This file
├── spec.md              # Feature specification (clarified 2026-10-31)
├── research.md          # Phase 0: decisions R1-R14 with exact versions and digests
├── data-model.md        # Phase 1: tables, state machine, configuration files
├── quickstart.md        # Phase 1: the 14 acceptance checks as commands
├── contracts/           # Phase 1: api.md, parser.md, parser-manifest.schema.json, type-schema.md,
│                        #          reasons.schema.json, thresholds.schema.json, llm-port.md,
│                        #          eval-report.schema.json, compose.md
├── checklists/          # requirements.md (spec quality)
└── tasks.md             # Phase 2 output (/speckit-tasks - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
compose.yaml                 # five services + model-pull + fixtures (contracts/compose.md)
.env.example                 # placeholders only
config/
├── reasons.json             # 15 codes, templates uk/en (contracts/reasons.schema.json)
├── classes.json             # synthetic, unverified, may_leave
├── thresholds.json          # every tunable value, provisional (contracts/thresholds.schema.json)
└── model.json               # model tag and pinned digest (T067)
schemas/
├── invoice.v1.json
├── act.v1.json
└── contract.v1.json         # contracts/type-schema.md
db/
└── init/
    ├── 001-role.sql         # app role without superuser
    └── 002-schema.sql       # tables of data-model.md + schema_version row
app/                         # Node package: API, worker, front build
├── Dockerfile               # multi-stage: web build, then node slim runtime
├── package.json             # exact versions (research R1)
├── tsconfig.json            # erasableSyntaxOnly, verbatimModuleSyntax, noEmit
├── src/
│   ├── main.ts              # startup checks, then server + worker
│   ├── server.ts            # Fastify instance, onRequest hook, helmet, static, routes
│   ├── worker.ts            # claim loop; takes its own dependencies, never the Fastify instance
│   ├── eval.ts              # evaluation command (FR-048, FR-048a)
│   ├── config/              # loaders + ajv validation of config files; startup refusals
│   ├── registry/            # schema loading, wire schema, classify enum, prompt, labels
│   ├── reasons/             # reasons file, template rendering, status()
│   ├── intake/              # inbox listing, hashing, upload streaming, class rule, duplicates
│   ├── parser-client/       # Unix socket client, safe reading of job outputs
│   ├── llm/                 # port types, dispatcher, ollama adapter, replay adapter
│   ├── pipeline/            # steps parse/classify/extract/check, normalisation, fragment search, checks
│   ├── shared/              # checksums, pinned normalisation, value parsing (R12, R13); copied into the fixtures image
│   ├── db/                  # pool, parameterised queries, claim/lease, transactions
│   └── api/                 # route handlers (contracts/api.md)
├── test/
│   ├── ollama-contract.test.ts
│   ├── status.test.ts               # table over all 15 codes
│   ├── wire-schema.test.ts          # snapshots per type
│   ├── safe-read.test.ts            # symlink, hard link, oversized manifest
│   ├── manifest.test.ts             # golden parser outputs validate
│   ├── pipeline-replay.test.ts      # fixtures end to end on the replay adapter; INTERNAL_ERROR x3 -> FAILED
│   ├── checks.test.ts               # VAT, dates, EDRPOU, IBAN, normalisation
│   ├── i18n.test.ts                 # dictionaries, labels and templates complete in uk and en
│   ├── eval.test.ts                 # the eval on a replayed run passes; one changed expected value fails it
│   ├── requeue.test.ts              # boot requeue of a row left in flight by a dead instance
│   ├── registry.test.ts             # an extra type schema changes the classify enum, labels and registryHash
│   ├── todo.test.ts                 # every deferred simplification in todo.ts, the WARN output and /api/health
│   └── fixtures/                    # replay recordings, golden manifests, snapshots, the receipt example schema
└── web/                     # Vite + React, built into app/dist/web and served by @fastify/static
    ├── index.html
    ├── vite.config.ts       # base: ''
    └── src/
        ├── main.tsx, App.tsx
        ├── components/      # Header.tsx: health, TODO list, language switch
        ├── views/           # Inbox.tsx, Documents.tsx, Document.tsx
        ├── api.ts           # fetch wrapper with X-Reader-Request, polling
        └── i18n/            # uk.json, en.json, t()
parser/                      # Node package, built-ins only; image with the document tools
├── Dockerfile               # targets: parser, fixtures
├── package.json
├── src/
│   ├── server.ts            # HTTP over /jobs/parser.sock, one job at a time
│   ├── parse.ts             # one-shot parse(in, out) run as a child process per job
│   └── tools/               # detect (file), soffice, pdfinfo/pdftotext/pdftoppm/pdftocairo, tesseract, rsvg
└── fixtures/
    ├── generate.ts          # deterministic generator: templates -> formats, manifest, expected
    ├── data.ts              # the fixed data object of the eleven documents
    ├── templates/           # invoice.html, act.html, contract.html
    ├── companies.ts         # fictional companies with valid EDRPOU and IBAN
    └── hostile.ts           # 5000-page PDF, 30000x30000 PNG
inbox/                       # bind mount; the generator's fixtures, manifest.json and expected/; ignored by git (.gitkeep)
results/                     # eval reports; ignored by git
```

**Structure Decision**: one repository, two Node packages. `app/` holds the API, the worker and the front because
the handoff fixes one process serving all three; `parser/` is a separate package and image because it must contain
the document tools and nothing else, run without network and never share dependencies with the app. No root
`package.json` (owner rule: a monorepo root is not created without agreement); each package is built by its own
Dockerfile with the repository root as build context, so the parser's `fixtures` target can copy `app/src/shared/`
(contracts/compose.md). Configuration and schemas live at the root and reach the containers as read-only bind
mounts, never copied into an image, so that both packages and the fixtures generator read the same files and a
schema or config change needs a restart only (acceptance check 10).

## Dependencies to approve (owner rule)

| Package | Why | Size (approximate, unpacked, estimate) |
| --- | --- | --- |
| fastify, @fastify/multipart, @fastify/static, @fastify/helmet | API server, streamed uploads, static front, CSP headers (owner decision) | ~3 MB with transitive deps |
| pg, @types/pg | PostgreSQL client with parameterised queries and transactions | ~0.5 MB |
| ajv, ajv-formats | JSON Schema 2020-12 validation of config, registry, model replies, manifests; `format: date` | ~1.5 MB |
| react, react-dom, @types/react, @types/react-dom | the front (owner decision) | ~5 MB dev-time; ~140 KB gzip shipped |
| vite, @vitejs/plugin-react | the front build (owner decision) | ~20 MB dev-time |
| typescript, @types/node | type check | ~25 MB dev-time |

Parser image apt packages: libreoffice-writer-nogui, libreoffice-calc-nogui, poppler-utils, tesseract-ocr,
tesseract-ocr-ukr, tesseract-ocr-eng, librsvg2-bin, imagemagick, img2pdf, file, fonts-dejavu-core,
fonts-liberation (versions in research R4). Not added: any ORM, router, TanStack Query, i18n library, Vitest,
Testing Library, Playwright (R3, R9, R10).

## Complexity Tracking

Named simplifications: each is a startup WARN and a `/api/health` `todo` entry shown in the page header
(constitution XII). They are the only justified departures.

| Violation | Why Needed | Simpler Alternative Rejected Because | Undo trigger |
| --- | --- | --- | --- |
| Parser under `runc`, not gVisor (VII baseline) | gVisor is not installed on the dev machine; the documents are synthetic | Installing gVisor now delays the first measurement for no real document | first non-synthetic document, non-local model, or leaving the dev machine |
| No invisible-text stripping, no `TEXT_LAYER_MISMATCH` | Attack only matters for real documents | Building it unmeasured adds code before the first eval | first non-synthetic document |
| No malware scan (`MALWARE` reserved) | Same | Same | first non-synthetic document |
| Model pulled into a volume, not baked into the image (XI, round 2 decision 12) | A 4 GB image rebuild per model change on one machine | Baking slows every change; digest verification covers integrity | first deployment off the dev machine |
| Single worker, boot requeue, no heartbeat (III) | One machine, one GPU, one call at a time | A heartbeat has no second worker to serve | second worker or replica |
| No migrations; `schema_version` check plus `down -v` | No data that cannot be regenerated | A migration tool is a dependency without a consumer (IX) | first hand labels or real documents |
| No role split, no SIGTERM drain | One process is the owner decision | Two processes double the Compose surface for one user | Kubernetes |
| `fields.bbox` always null | No reviewer UI consumes it | Computing boxes from the OCR table adds work nobody reads | the reviewer UI |
| No label-proximity rule against substitution | Not yet measured | Would be a guess before the eval | eval shows substitutions above threshold |
| `LOW_CONFIDENCE`, `EXTRACTORS_DISAGREE` not emitted | One extractor, one call | No lawful trigger exists | a second extraction or extractor |
| No review form; NEEDS_REVIEW is terminal | Out of scope by the owner | A form without a reviewer has no consumer (IX) | the owner asks for review |

## Phase 0: Research

Output: [research.md](research.md), decisions R1-R14: exact versions and digests (R1 npm, R2 images, R4 apt
packages), Ollama request and readiness facts (R5), Node type stripping and the test runner (R6), Fastify Unix
socket and hooks (R7), the parser toolchain and fixture formats (R8), library decisions by principle IX (R3, R9,
R10), the Host and Origin rule (R11), checksum algorithms (R12), fragment normalisation (R13), the thresholds'
starting values (R14). No NEEDS CLARIFICATION remains in Technical Context.

## Phase 1: Design

Outputs: [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md). Post-design
Constitution Check: PASS (table above re-evaluated against the data model and contracts; no new violation).

## Phase 2 preview (not part of this command)

`/speckit-tasks` will cut the work along the nine phases of the dashboard: skeleton and networks; model and
contract; registry and reasons; fixtures; sandbox and parsing; intake and queue; recognition and checks; the
front; the evaluation. Each phase ends with its acceptance checks from quickstart.md.
