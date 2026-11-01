# Tasks: Local Prototype of the Document Reader

**Input**: Design documents from `/specs/001-local-prototype/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included where the constitution requires them: the Ollama contract test (XI), the GPU-free suite that
covers the pipeline (Development Workflow), the status table test (VI) and the evaluation run with its pre-written
threshold (I). Front unit tests are not included (research R10).

**Organization**: Tasks are grouped by user story. Phase 1 and 2 build the shared skeleton every story needs; the
dashboard phase map at the end places every task on the nine phases of the project dashboard.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US6)
- Paths are repository-relative; `app/` and `parser/` are the two Node packages of plan.md

## Path Conventions

- Backend, worker and front build: `app/` (`app/src/`, `app/test/`, `app/web/`)
- Parser service and fixtures generator: `parser/` (`parser/src/`, `parser/fixtures/`)
- Configuration and schemas at the root: `config/`, `schemas/`, `db/init/`, `compose.yaml`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repository layout, pinned dependencies, images, Compose, configuration files (dashboard phase 0)

- [X] T001 Create the layout of plan.md: `app/src/{config,registry,reasons,intake,parser-client,llm,pipeline,db,api,shared}/`, `app/test/fixtures/`, `app/web/src/{views,i18n}/`, `parser/src/tools/`, `parser/fixtures/templates/`, `config/`, `schemas/`, `db/init/`, `inbox/.gitkeep`, `results/.gitkeep`; extend `.gitignore` with `.env`, `inbox/*` (keep `.gitkeep`), `results/*`, `node_modules/`, `app/dist/`
- [X] T002 [P] Write `app/package.json` with the exact versions of research R1 (no ranges; scripts `typecheck`, `test`, `build:web`, `start`, `eval`), `app/tsconfig.json` (nodenext, noEmit, strict, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions) and `app/web/tsconfig.json` (react-jsx, bundler resolution) per research R6
- [X] T003 [P] Write `parser/package.json` (type module, no runtime dependencies; `typescript` and `@types/node` as exact-pinned devDependencies for the type check, the same versions as `app/`; scripts `start`, `fixtures`, `typecheck`) and `parser/tsconfig.json` with the backend flags of research R6
- [X] T004 [P] Write `.env.example` with placeholders: `POSTGRES_PASSWORD`, `READER_INBOX=./inbox`, `READER_PORT=3000`, `MODEL_TAG=qwen3.5:4b`; never a real value
- [X] T005 [P] Write `db/init/001-role.sql` (database `reader`, role `app` with no superuser and no schema ownership, grants on the tables) and `db/init/002-schema.sql` with every table, index and the `schema_version` row of data-model.md
- [X] T006 [P] Write `app/Dockerfile`: stage `web` builds the front with Vite, stage `runtime` from `node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`, non-root user, `CMD ["node", "src/main.ts"]`
- [X] T007 [P] Write `parser/Dockerfile` from the same Node image digest: `apt-get install --no-install-recommends` with the pinned package versions of research R4 (read and pin the bookworm `qpdf` version while writing, and record it in research.md R4), user `10001`, targets `parser` (default), `fixtures` (copies `app/src/shared/` for the checksums) and `check` (type check of `parser/`)
- [X] T008 Write `compose.yaml` per contracts/compose.md: `db`, `model`, `model-pull`, `parser`, `app`, `fixtures`; networks `backend` (`internal: true`), `egress`, `ui`; volumes `pgdata`, `models`, `blobs`, `jobs`, `jobs_in` (`./results` is a bind mount, not a volume); bind mounts: the inbox, `./config` and `./schemas` read-only into `app`, the inbox read-write and `./schemas` read-only into `fixtures`; `build: { context: ., dockerfile: app/Dockerfile }` and `parser/Dockerfile` with targets `parser` and `fixtures`; image digests of research R2; GPU reservation for `model`; `OLLAMA_HOST=0.0.0.0:11434` (Ollama binds 127.0.0.1 by default), `OLLAMA_CONTEXT_LENGTH=16384` (the same number as `thresholds.model.num_ctx`, verified at readiness by T024), `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=30m`; the sandbox flags of C9 with `# TODO runtime: runsc`; port `127.0.0.1:3000:3000`; `READER_SANDBOX_RUNTIME=runc` on `app` (the parser's runtime, for `/api/health`); `pg_isready -h 127.0.0.1` healthcheck (over TCP: during init the temporary server listens on the socket only); `db` runs as `999:999`, and `db`, `model` and `app` drop every capability and set `no-new-privileges`
- [X] T009 [P] Write `config/thresholds.json` with every key and value of research R14 (all `provisional`), `config/classes.json` (`synthetic`, `unverified`, both `may_leave: false`) and `config/model.json` (`{ "tag": "qwen3.5:4b", "digest": "" }`, filled by T067)
- [X] T010 [P] Write `config/reasons.json`: the 15 codes with outcome, `emitted` (11 true, 4 false), `emittedBy`, trigger, params and `templates.uk` / `templates.en` as in spec FR-024 and C1 (the `VALIDATION_FAILED` fragment template verbatim)
- [X] T011 [P] Write `schemas/invoice.v1.json`, `schemas/act.v1.json`, `schemas/contract.v1.json` per contracts/type-schema.md with the field sets of spec Key Entities, `x-reader` labels in uk and en, `order` and `checks`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Modules every story depends on: configuration, database, reasons, registry, LLM port, parser service,
fixtures, server and worker skeleton. No user story work starts before this phase is complete.

- [X] T012 Copy `contracts/*.schema.json` into `app/src/config/schemas/` (the copy in app is the one the code reads; the files under specs/ stay the design record) and write `app/src/config/ajv.ts`: one `Ajv2020` instance (`strict: true`, `allErrors: false`) with `ajv-formats`, plus compiled validators for thresholds, classes, reasons, model config and the parser manifest
- [X] T013 Write `app/src/config/load.ts`: load and validate `config/*.json` and `schemas/*.json` at start; exit non-zero naming the class when a class lacks `may_leave` (FR-007); expose typed config to the rest of the app
- [X] T014 Write `app/src/db/pool.ts` (pg pool from env) and `app/src/db/startup.ts`: read `schema_version`, refuse to run on a mismatch with a message naming both versions (FR-034)
- [X] T015 Write `app/src/db/queries.ts`: parameterised queries for documents (insert, by sha256, by number, list), pages, page_texts, extractions, fields, reasons, step_runs; `app/src/db/tx.ts` with a `withTransaction` helper; identifiers only from code (FR-035)
- [X] T016 Write `app/src/db/claim.ts`: claim with `SELECT ... FOR UPDATE SKIP LOCKED`, `locked_until = now() + lease(step)`, `attempts + 1`; finish and requeue helpers; boot requeue of rows locked by this instance id (FR-031, data-model.md state machine)
- [X] T017 Write `app/src/reasons/reasons.ts` (load the file, `render(code, params, lang)`, which uses the first entry of `variants` whose `when` values all equal the params and otherwise the base template) and `app/src/reasons/status.ts`: `status(reasons, attempts, checksDone)` with the INTERNAL_ERROR attempt rule of data-model.md (FR-026)
- [X] T018 [P] Write `app/test/status.test.ts`: table over all 15 codes, both attempt branches, `DUPLICATE` never reaching the function (acceptance check 9)
- [X] T019 Write `app/src/registry/registry.ts` (load `schemas/*.json`, validate `x-reader`, labels uk and en, `order`, `registryHash`), `app/src/registry/wire.ts` (`wireSchema`, `classifySchema`) and `app/src/registry/prompt.ts` (fixed template, `promptHash`) per contracts/type-schema.md
- [X] T020 [P] Write `app/test/wire-schema.test.ts` with JSON snapshots in `app/test/fixtures/snapshots/` (no `x-` keys, explicit absent path per field, `UPDATE_SNAPSHOTS=1` to regenerate)
- [X] T021 [P] Write `app/src/shared/checksums.ts` (EDRPOU, Ukrainian IBAN mod 97, research R12), `app/src/shared/normalize.ts` (pinned normalisation with an offset map, research R13) and `app/src/shared/values.ts` (date and money parsing, enum match)
- [X] T022 [P] Write `app/test/checks.test.ts`: valid and invalid EDRPOU and IBAN, the normalisation table, date formats, money formats, exact VAT arithmetic in kopiyky
- [X] T023 Write `app/src/llm/port.ts` (types of contracts/llm-port.md) and `app/src/llm/dispatcher.ts`: class gate (`may_leave`), context budget check with `chars_per_token` (over budget throws `PromptOverBudget`), one call at a time
- [X] T024 Write `app/src/llm/ollama.ts`: `/api/chat` with `think: false`, `format`, `keep_alive`, `options.num_predict`; fallbacks `/api/generate` and `think: true`; ajv validation of every reply; readiness from `/api/tags` digest plus a warm-up call plus `/api/ps` `context_length` equal to `thresholds.model.num_ctx` (a mismatch keeps the model `missing` and logs WARN with both numbers); timings, counts, `cold` flag; client timeout from thresholds (research R5)
- [X] T067 Pull the model once with `docker compose run --rm model-pull`, read the full sha256 of `qwen3.5:4b` from `GET /api/tags` and pin it in `config/model.json`; verify readiness reports `ready` only with that digest and `missing` otherwise (FR-037, research R2 open item; keeps its number and runs here because no model step can be claimed before the pin)
- [X] T025 [P] Write `app/src/llm/replay.ts`: adapter that serves recordings from `app/test/fixtures/replay/<sha256 of request>.json` and fails on a missing recording
- [X] T026 [P] Write `app/test/ollama-contract.test.ts`: five calls with the invoice wire schema on a fixed page text; each reply parses and validates, `message.thinking` empty, `done_reason` `stop`; skipped unless `MODEL_URL` is set (acceptance check 1)
- [X] T027 Write `parser/src/tools/run.ts` (spawn in its own process group with timeout and memory limit, kill the group on timeout) and the tool wrappers `detect.ts` (`file --mime-type -b`), `soffice.ts`, `poppler.ts` (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`), `tesseract.ts` (`txt tsv` in one pass), `rsvg.ts`, `image.ts` (PNG and JPEG header dimensions, `convert -resize`)
- [X] T028 Write `parser/src/parse.ts`: one-shot `parse(inDir, outDir)` per contracts/parser.md: route by mime, `pdfinfo` checks (page cap, page size, `Encrypted`), office to PDF, per-page text or OCR by the scanned-page rule, previews at `render_width_px`, OCR at `ocr_dpi`, reason mapping (`TOO_LARGE`, `CORRUPT`, `ENCRYPTED`, `UNSUPPORTED_FORMAT`), `manifest.json` written last
- [X] T029 Write `parser/src/server.ts`: `http.createServer` on `/jobs/parser.sock` (unlink a stale socket first), `POST /parse {jobId}` validation, one job at a time (`429`), each job a fresh `node src/parse.ts` child with its own tmp dir and LibreOffice profile, kill leftovers of the uid after the job and exit if any survive; create the socket with mode `0660` (group 10001, the app's group): the default `0755` makes the app's connect fail with `EACCES`, shown on a fresh `jobs` volume
- [X] T030 Write `app/src/parser-client/client.ts` (`http.request` over `socketPath`, timeout, 429 backoff) and `app/src/parser-client/safe-read.ts`: empty `out/<jobId>/` before dispatch; `lstat`, `O_NOFOLLOW`, `nlink == 1`, size caps, PNG signature and IHDR check, manifest validation with `additionalProperties: false`, fixed name patterns, no path from the manifest (FR-014)
- [X] T031 [P] Write `app/test/safe-read.test.ts` (a symlinked `page-1.png`, a hard link, a 1 GB sparse `manifest.json`: each fails the job with nothing read) and `app/test/manifest.test.ts` (golden manifests in `app/test/fixtures/golden/` validate; a manifest with an extra key fails)
- [X] T032 [P] Write `parser/fixtures/companies.ts` (three fictional companies with valid EDRPOU and IBAN from `shared/checksums.ts`) and `parser/fixtures/data.ts`: the fixed data object of the 9 typed documents (one per type missing one required field), the wrong-VAT invoice (off by at least 1 UAH) and the untyped document
- [X] T033 [P] Write `parser/fixtures/templates/invoice.html`, `act.html`, `contract.html`: Ukrainian templates with every field of the schemas, DejaVu or Liberation fonts, filled from `data.ts`; and `letter.html`, the template of the untyped document
- [X] T034 Write `parser/fixtures/generate.ts`: templates to PDF, DOCX, DOC, RTF, XLSX with `soffice`; scanned PDF, PNG and JPG through `pdftoppm`, `convert -rotate -blur +noise -seed -strip`, `img2pdf --nodate`; SVG through `pdftocairo -svg`; `SOURCE_DATE_EPOCH` and `qpdf --deterministic-id` for byte-stable output; `inbox/manifest.json` and `inbox/expected/<sha256>.json` from the same data object (both in the inbox: the `app` container reads them there); a second run verifies identical hashes (FR-044, FR-047; build order: text PDF end to end first, then one format per step)
- [X] T035 [P] Write `parser/fixtures/hostile.ts`: a 5000-page PDF and a PNG whose header says 30000 x 30000 (`TOO_LARGE`), a password-protected PDF (`ENCRYPTED`), a truncated DOCX (`CORRUPT`), a `.zip` (`UNSUPPORTED_FORMAT`), a blank-page PDF (`EMPTY`) and a noise-only PNG (`LOW_OCR_QUALITY`), written into the inbox on demand and never listed in the manifest (acceptance check 8, spec Edge Cases)
- [X] T036 Write `app/src/server.ts`: Fastify with pino logger, `onRequest` Host and Origin hook of research R11 (`421`, `403`, header `X-Reader-Request`), `@fastify/helmet` with `default-src 'self'; img-src 'self'; frame-ancestors 'none'`, `@fastify/static` for `app/dist/web`, the error shape of contracts/api.md; `app/src/api/health.ts` (`GET /health`, `sandbox` from `READER_SANDBOX_RUNTIME`) and `app/src/api/meta.ts` (`GET /meta` from the registry and the reasons file, each reason with its `variants` when it has them), every route registered under the `/api` prefix of contracts/api.md; `app/src/main.ts` (startup checks in order: config, classes, schema_version, then the server; the model status of `/health` comes from an injected readiness function that reports `missing` until T067 wires the Ollama adapter in)
- [X] T037 Write `app/src/config/todo.ts`: the thirteen named simplifications of the spec.md Deferred Simplifications table (the single source; plan.md Complexity Tracking mirrors it) with `uk` and `en` texts and triggers; logged as WARN at start and returned by `/api/health` (FR-052)
- [X] T038 Write `app/src/worker.ts` (claim loop with the poll interval, step dispatch table, lease expiry handling, no LLM claim while the model is missing, boot requeue; takes pool, ports, thresholds and logger as parameters, never the Fastify instance) and its wiring into `app/src/main.ts`, which T036 wrote: the worker starts after the server
- [X] T039 Write the front skeleton: `app/web/index.html`, `app/web/vite.config.ts` (`base: ''`, outDir `../dist/web`), `app/web/src/main.tsx`, `app/web/src/App.tsx` (three views as component state, no router), `app/web/src/api.ts` (`fetch` wrapper adding `X-Reader-Request: 1`, `poll(url, 2000)`), `app/web/src/i18n/uk.json`, `en.json`, `t.ts` with the language in `localStorage["reader.lang"]`, default `uk`
- [X] T040 [P] Write `app/test/i18n.test.ts`: the two dictionaries have equal key sets; every registry label and every reasons template exists in uk and en (FR-058)
- [X] T077 Write the page shell of the front: `app/web/src/styles.css` (semantic CSS variables, a dark theme as the default and a light theme, both in Ukrainian tones; system sans stack; flat panels; no gradients, animations or inline styles), `app/web/src/theme.ts` (the light | dark choice, kept in `localStorage["reader.theme"]`, dark when nothing is stored), `app/web/src/components/Header.tsx` (the title and two one-button switches: the language, which shows the other language, FR-057, and the theme, which shows a sun or a moon) and the dictionary keys they need, wired into `App.tsx` and `main.tsx`; the language choice is kept in `localStorage["reader.lang"]`

**Checkpoint**: `docker compose up -d` starts every service, `/api/health` answers (`model: ready` once T067 has
pinned the digest), `node --test` passes the foundational tests with the model stopped, the fixtures generator
produces 11 files with identical hashes twice.

---

## Phase 3: User Story 1 - Read the synthetic folder end to end (Priority: P1) MVP

**Goal**: "Read folder" takes the eleven fixtures through parse, classify, extract and checks to the expected
terminal statuses, with duplicates reported and the model outage handled.

**Independent Test**: acceptance checks 4, 5 and 11 of quickstart.md; the replay pipeline test without the GPU.

- [X] T041 [US1] Write `app/src/intake/inbox.ts`: top-level listing (skip dot-files, subfolders including `expected/`, and `manifest.json`), hashing on read only, class rule (`synthetic` when the sha256 is in the manifest, else `unverified`), duplicate detection by sha256, blob store under `blobs/<sha256[0:2]>/<sha256>`, `RECEIVED` row with the next visible number (FR-001 to FR-006)
- [X] T042 [US1] Write `app/src/api/inbox.ts`: `GET /inbox` and `POST /inbox/read` with the `taken`, `duplicates`, `skipped` shape of contracts/api.md
- [X] T043 [US1] Write `app/src/pipeline/parse.ts`: mint a job id, copy the original to `jobs/in/<jobId>/input`, call the parser, safe-read the outputs, store `pages`, `page_texts` (with thresholds snapshot and timings), `step_runs` and the status change in one transaction (FR-030); apply the `LOW_OCR_QUALITY` and `EMPTY` rules of research R14; map parser reasons; compute the status with `status()`
- [X] T044 [US1] Write `app/src/pipeline/classify.ts`: classify enum from the registry, prompt and `promptHash`, call through the dispatcher, store the extraction with raw request and response together with the status change in one transaction, `UNKNOWN_DOC_TYPE` with no field rows on `none` (FR-016)
- [X] T045 [US1] Write `app/src/pipeline/extract.ts`: wire schema of the detected type, budget check (`TOO_LARGE` when over), one call, `done_reason: length` to REJECTED `TOO_LARGE` with the generation cap as the breached limit, without retry, store the extraction with its thresholds snapshot and the status change in one transaction (FR-017, FR-022, FR-030, FR-051)
- [X] T046 [US1] Write `app/src/pipeline/evidence.ts`: locate every verbatim fragment in the page texts with the pinned normalisation, map offsets back, derive the typed value with `shared/values.ts`; the module is pure, and `check.ts` writes the `fields` rows with `page_text_id` and offsets in its transaction from the stored reply, because the page the model named is kept only there (FR-018, FR-019)
- [X] T047 [US1] Write `app/src/pipeline/check.ts`: run the registry checks (`vat_sum`, `date_order`, `edrpou`, `iban_ua`, business `required`, fragment located) with the templates of C1 and C11, write `reasons`, set `checks_done`, `accepted_extraction_id` when accepted and the final status, all in one transaction (FR-021, FR-026, FR-030)
- [X] T048 [US1] Write `app/src/pipeline/failures.ts`: the C6 mapping (tool over its limit to `TOO_LARGE` without retry, file-caused tool error to `CORRUPT`, infrastructure, timeout or invalid JSON to `INTERNAL_ERROR`, `FAILED` after three attempts, lease expiry as an attempt) and wire it into the worker's step dispatch (FR-027)
- [X] T049 [US1] Write `app/src/api/documents.ts`: `GET /documents` list with reasons as `{code, params}`, never page texts or raw data, sorted by number descending (FR-054)
- [X] T050 [US1] Write `app/web/src/views/Inbox.tsx`: the file list, the "Read folder" action and its result (taken, duplicates with the original's number, skipped), texts through `t()`
- [X] T051 [US1] Write `app/web/src/views/Documents.tsx`: the table (number, name, class, type, status, reasons rendered from `/meta` templates in the active language) polling every 2 seconds
- [X] T052 [US1] Record the fixtures run once with the GPU into `app/test/fixtures/replay/` and the golden parser outputs into `app/test/fixtures/golden/`; write `app/test/pipeline-replay.test.ts`: the eleven fixtures reach the expected statuses against the real `db` service through the replay adapter; three invalid JSON replies end a document `FAILED`; a recording with `done_reason: length` ends one REJECTED `TOO_LARGE` after a single attempt (acceptance check 9)
- [X] T053 [US1] Run quickstart.md checks 4 (folder run), 5 (re-read) and 11 (model outage) on the real stack and fix what fails until all three pass

- [X] T078 [US1] Add pages to `GET /documents` (`offset`; `limit` and `offset` echoed in the answer, contracts/api.md), the rows `ui.page_size` (20) and `ui.page_size_options` ("10,20,50,100") to `config/thresholds.json` with both copies of the thresholds schema, the two values in `GET /meta` as `pageSize` and `pageSizes`, and the pure `app/src/shared/pager.ts` (`pageWindow`, `pageItems`, `pageAfterResize`) with `app/test/pager.test.ts` and the page cases in `app/test/documents-api.test.ts` (FR-053)
- [X] T079 [US1] Write `app/web/src/components/Pager.tsx` (the buttons previous and next, always shown and disabled where they cannot act, with the numbers of the pages between them, the first and the last always among them and an ellipsis for the pages left out; the range of rows; a choice of the page size in the same line) and use it in `app/web/src/views/Documents.tsx` (pages from the server) and `app/web/src/views/Inbox.tsx` (pages cut in the browser); the page size is shared by the two views and kept in `App.tsx`; texts through `t()` (FR-053, FR-057)
- [X] T080 [US1] Verify in the browser, in both languages and both themes, and at a narrow width: with the page size 10 the twenty documents make two pages, the previous and next buttons are disabled at the first and at the last page, the first and the last page are always among the numbers, a change of the page size keeps the first visible row, the folder list pages the same way; fix findings
- [X] T081 [US1] Show the technical names a reason carries (the program that failed, `tool`; the breached `limit`; the `cause` of an internal error) under human names from the two dictionaries (`tool.*`, `limit.*`, `cause.*` in `app/web/src/i18n/uk.json` and `en.json`), applied in `reasonText` of `app/web/src/labels.ts` beside the field labels, and a value without a name shown as stored; a test in `app/test/i18n.test.ts` that every value the code emits has a name in both languages and that no name is left without a value (FR-025, FR-058)
- [X] T082 [US1] Give the controls one look in `app/web/src/styles.css`: the buttons, the page-size select and the button of the file chooser share padding, border, radius, colours and font, the current page is marked like the selected tab, and the bottom stripe of the header is yellow in the dark theme and blue in the light one; verify in both languages and both themes and at a narrow width (FR-053)
- [X] T083 [US1] Let the result of "Read folder" be hidden and brought back in `app/web/src/views/Inbox.tsx`: a "Hide" button in the head of the result panel, a "Show the result of the read" button beside "Read folder" while the result is hidden, and a new read shows the result again; texts through `t()` (FR-001, FR-057)
- [X] T084 [US1] Show a long result of a read in pages in `app/web/src/views/Inbox.tsx`, the page size shared with the other lists and the page of the result kept by the result itself, and put the pager of every list (the folder list, the documents table, the result of a read) below the list and not above it, in `Inbox.tsx` and `app/web/src/views/Documents.tsx` (FR-053); verify in both languages and both themes
- [X] T085 [US1] Draw the file chooser in `app/web/src/views/Inbox.tsx`: a button of the page opens the hidden file input, the line beside it shows the name of the file last chosen or "no file chosen", and both texts come from the dictionaries (`upload.choose`, `upload.none`), so they follow the language; drop the styles of the native chooser from `app/web/src/styles.css` (FR-004, FR-057); verify in both languages and both themes
- [X] T086 [US1] Make the page notice a newer build: `app/src/shared/build.ts` (`assetsOf`, `isNewBuild`: the built files the served HTML names against the ones the running page came from) with `app/test/build.test.ts`, `app/web/src/components/NewVersion.tsx` (asks for `index.html` every 30 s without the cache, shows the notice with a reload button, stops after the first new build, ignores a failed check), its place in `app/web/src/App.tsx`, the texts `update.*` in both dictionaries and the style `.update` (FR-059, FR-057); verify in the browser in both languages and both themes

**Checkpoint**: User Story 1 passes its three checks; the documents table shows 6 ACCEPTED, 3 + 1 + 1 NEEDS_REVIEW
with rendered reasons.

---

## Phase 4: User Story 2 - See a document's evidence (Priority: P1)

**Goal**: The detail view shows fields with fragments and pages, step durations, model identity, rendered reasons,
and the collapsed raw model request and response.

**Independent Test**: open an ACCEPTED and a NEEDS_REVIEW fixture in the browser and verify every element of
spec User Story 2, scenarios 1 to 5.

- [X] T054 [US2] Write `app/src/api/document.ts`: `GET /documents/{number}` with fields and evidence, pages, step runs with durations, model identity and reasons, `404` for an unknown number (contracts/api.md)
- [X] T055 [P] [US2] Write `app/src/api/raw.ts`: `GET /documents/{number}/raw` with the raw request and response of each extraction of this one document (FR-053a)
- [X] T056 [P] [US2] Write `app/src/api/pages.ts`: `GET /documents/{number}/pages/{page}.png` from the blob store as `image/png` with `nosniff` and private caching; no endpoint for originals (FR-054)
- [X] T057 [US2] Write `app/web/src/views/Document.tsx`: fields with value, fragment, page and found flag; pages lazily loaded and capped in width; steps with durations; model identity; reasons rendered as text; a collapsed "Model request and response" block that fetches `/raw` on expand and renders plain text (FR-053, FR-053a, FR-055)
- [X] T058 [US2] Verify in the browser that `app/web/src/views/Document.tsx` and `Documents.tsx` never render document text, fragments or reasons as HTML (FR-055) and that `app/src/api/documents.ts` returns no page text or raw data (FR-054); fix findings

**Checkpoint**: User Stories 1 and 2 work together: table to detail and back without a router.

---

## Phase 5: User Story 3 - Upload a document from the browser (Priority: P2)

**Goal**: A browser upload is stored under its hash, classed `unverified`, deduplicated, and processed like a folder
document.

**Independent Test**: acceptance check 6 of quickstart.md plus a duplicate upload of a fixture copy.

- [X] T059 [US3] Write `app/src/api/upload.ts` (the streaming, hashing and duplicate check it shares with the folder read are in `app/src/intake/store.ts` and `take.ts`): `POST /documents` with `@fastify/multipart` (`limits.fileSize` from thresholds, `files: 1`, never `saveRequestFiles`), streamed to the blob store while hashing, `201` for a new document with the class of the one intake rule (`unverified` unless its hash is in the generator manifest), `200 DUPLICATE` with the original's number for a known hash, `413 too_large` over the limit (FR-003, FR-004)
- [X] T060 [US3] Add the upload control and its result display to `app/web/src/views/Inbox.tsx` (new number or duplicate with the original's number)
- [X] T061 [US3] Run quickstart.md check 6 (class of an outside file, every fixture `synthetic`) and the duplicate upload; fix findings

**Checkpoint**: both intake channels behave the same for identity, class and duplicates.

---

## Phase 6: User Story 4 - Measure the run (Priority: P2)

**Goal**: The evaluation prints every figure of the Measurement Contract, writes one JSON report per run and
judges the run against the written threshold; the GPU-free suite is complete.

**Independent Test**: acceptance checks 9, 12 and 14 of quickstart.md.

- [ ] T062 [US4] Write `app/src/eval.ts`: load `inbox/expected/*.json` by sha256, compare with the accepted or latest extraction of each document; compute per-field match, required-field match on the ACCEPTED fixtures, false accepts, reason shares, seconds per page split parse and model, cold and warm, tokens per document, characters per token; print the text report and the line `not a tier decision`; write `results/eval-<YYYYMMDD-HHMMSS>-<digest prefix>.json` per contracts/eval-report.schema.json; exit non-zero below `eval.*` thresholds (FR-048, FR-048a, FR-049)
- [ ] T063 [P] [US4] Write `app/test/eval.test.ts`: the eval on a replayed run passes with exit 0 and a valid report; a copy of the expected values with one changed amount fails with a non-zero exit
- [ ] T064 [US4] Run quickstart.md check 14 on the real run; create the measurement journal table in `README.md` (date, what changed, model digest, schema versions, field match, false accepts, seconds per page, tokens per document) and add its first row from the JSON report
- [ ] T065 [US4] Run quickstart.md checks 9 (`docker compose stop model` then `node --test`) and 12 (`ollama ps`, `done_reason` query); fix findings

**Checkpoint**: the numbers the project exists to produce are on screen, in `results/` and in the README journal.

---

## Phase 7: User Story 5 - Operate the prototype (Priority: P3)

**Goal**: One command starts everything; health, header and startup warnings show the state and the named
simplifications; restarts lose and duplicate nothing; misconfiguration refuses to start.

**Independent Test**: acceptance checks 2, 3 and 13 of quickstart.md plus the refusals of SC-009.

- [X] T066 [US5] Extend `app/web/src/components/Header.tsx` (created by T077 with the title and the language switch): model state, sandbox runtime, the TODO list from `/health` in the active language (FR-052)
- [X] T068 [US5] Write `app/test/requeue.test.ts`: a document claimed by a dead instance id is requeued at start and completes without a duplicate row; run the manual check (`docker compose kill app` mid-step, `up -d`, the document reaches a terminal status once)
- [X] T069 [US5] Run quickstart.md checks 2 (cold start, no FAILED, second start downloads nothing), 3 (sandbox, networks, unpublished ports), 8 (the hostile set of T035: each file ends with its expected code after one attempt, every container still up) and 13 (Host and Origin), and the two refusals of SC-009 (missing egress rule, schema version mismatch); fix findings

**Checkpoint**: the prototype is repeatable on the owner's machine from `down -v` to a green run.

---

## Phase 8: User Story 6 - Register a new document type (Priority: P3)

**Goal**: Adding a schema file is enough for the classifier to offer the type.

**Independent Test**: acceptance check 10 of quickstart.md.

- [X] T070 [US6] Write `app/test/fixtures/registry/receipt.v1.json` (a minimal fourth type with labels in both languages; inside the app package so the test runs in the container) and `app/test/registry.test.ts`: loading a registry with the extra file changes the classify enum, the `registryHash` and the labels; a schema without `uk` or `en` labels is refused at start
- [ ] T071 [US6] Run quickstart.md check 10 (copy the example into `schemas/`, restart, upload a file whose hash is not yet known, since a fixture copy is a `DUPLICATE` and runs no classification, inspect its classify `rawRequest`); remove the example from `schemas/` afterwards; fix findings

**Checkpoint**: all six user stories pass their checks.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, secrets, logging, completeness of the named simplifications, the full quickstart run.

- [ ] T072 [P] Update `README.md`: how to run (`docker compose up -d`, the fixtures, the eval), where the reports land, a pointer to the measurement journal table of T064, a pointer to the named simplifications in `/api/health`
- [ ] T073 [P] Secrets review: grep the repository for anything that looks like a password or key; confirm `.env` is ignored, `.env.example` has placeholders only, and no test or log prints an environment value
- [ ] T074 [P] Logging review of `app/src/`: ids, sha256, codes, timings and model metadata only; no page text, field value, fragment or raw model response at any level (AGENTS.md rule); fix findings
- [ ] T075 Write `app/test/todo.test.ts`: every row of the Deferred Simplifications table of spec.md appears in `config/todo.ts`, in the startup WARN output and in `/health` `todo` in both languages (constitution XII)
- [ ] T076 Run quickstart.md end to end, checks 1 to 14 plus the FR-057 language check, and record the date and outcome of each check at the end of `specs/001-local-prototype/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T002-T011 run in parallel after T001.
- **Foundational (Phase 2)**: depends on Setup; blocks every user story. Inside it: T012-T014 first (config, db),
  then T015-T017, T019, T021, T023-T024, T067, T027-T030, T032-T034, T036-T039 in dependency order; the [P] tests and
  adapters alongside their modules.
- **User Story 1 (Phase 3)**: depends on Foundational; it is the MVP.
- **User Story 2 (Phase 4)**: depends on Foundational and on T049 (the list) for navigation; otherwise independent.
- **User Story 3 (Phase 5)**: depends on Foundational and T041 (blob store and class rule).
- **User Story 4 (Phase 6)**: depends on US1 (a completed run and the replay recordings of T052).
- **User Story 5 (Phase 7)**: depends on Foundational. T067 (the digest pin) runs in Phase 2 right after T024 and
  keeps its number: no model step can be claimed before it.
- **User Story 6 (Phase 8)**: depends on Foundational (T019).
- **Polish (Phase 9)**: depends on every desired story.

### Within Each User Story

- Intake and pipeline modules before API routes, routes before views.
- Tests of a story may be written before its modules and must fail first.
- A story is complete when its quickstart checks pass on the real stack.

### Parallel Opportunities

- Phase 1: T002, T003, T004, T005, T006, T007, T009, T010, T011 together after T001.
- Phase 2: the parser package (T027-T029), the fixtures (T032-T035), the LLM port (T023-T026) and the app core
  (T012-T022) touch different folders and can proceed side by side; T036-T039 after the app core.
- Phase 4: T055 and T056 together; Phase 6: T063 alongside T062.
- Phase 9: T072, T073, T074 together.

---

## Parallel Example: Foundational

```bash
# Four independent tracks after T001-T011:
Task: "Parser service: T027 tools, T028 parse, T029 server in parser/src/"
Task: "Fixtures: T032 companies and data, T033 templates, T034 generator, T035 hostile in parser/fixtures/"
Task: "LLM port: T023 port and dispatcher, T024 ollama, T025 replay, T026 contract test, T067 digest pin in app/src/llm/ and app/test/"
Task: "App core: T012-T022 config, db, reasons, registry, shared in app/src/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup, then Phase 2 Foundational (the bulk of the work: skeleton, parser, model, fixtures).
2. Phase 3 User Story 1: the folder run end to end.
3. Stop and validate with quickstart checks 4, 5, 11 and the GPU-free suite.

### Incremental Delivery

1. Setup + Foundational: `docker compose up -d` is green, fixtures exist, tests pass without the GPU.
2. US1: the folder run (MVP). 3. US2: the evidence view. 4. US3: upload. 5. US4: the numbers. 6. US5: operability
checks. 7. US6: registry extension. 8. Polish and the full quickstart.

### Dashboard phase map

The project dashboard groups work by nine phases. Each task belongs to one of them:

| Dashboard phase | Tasks |
| --- | --- |
| 0 Skeleton and networks | T001, T002, T003, T004, T005, T006, T008, T009, T012, T013, T014, T037 |
| 1 Model and contract | T023, T024, T025, T026, T067 |
| 2 Schema registry and reasons | T039, T010, T011, T017, T018, T019, T020, T021, T022, T036, T070, T077 |
| 3 Synthetic documents | T007, T032, T033, T034, T035 |
| 4 Sandbox and parsing | T027, T028, T029, T030, T031 |
| 5 Intake and queue | T015, T016, T038, T041, T042, T043, T048, T059, T061, T068 |
| 6 Recognition and checks | T044, T045, T046, T047, T052, T053 |
| 7 Interface | T040, T049, T050, T051, T054, T055, T056, T057, T058, T060, T066, T069, T078, T079, T080, T081, T082, T083, T084, T085, T086 |
| 8 Measurement | T062, T063, T064, T065 |
| Cross-cutting | T071, T072, T073, T074, T075, T076 |

Slices follow these phases; `slices.md` gives, per slice, the documentation servers to start, the tasks and the condition
that closes it. Its execution order differs from the numbering in one place: phase 2 runs before phase 1, because the
contract test T026 sends the invoice wire schema that T019 derives. T039 (the front skeleton) opens phase 2: the `web` stage
of `app/Dockerfile` runs `vite build`, so the `app` image, which every later slice needs, does not build without it.
T036 and T070 close phase 2, T077 (the page shell) was added after phase 2 had closed and sits with it, T043 sits with the queue in phase 5, T071 needs the whole stack and closes the work.
Task numbers do not change.

---

## Notes

- [P] tasks touch different files and have no unfinished dependency.
- Every task names its files; a task that says "run quickstart check N" ends with that check's output shown.
- Commit after each phase checkpoint, on the owner's word.
- Nothing in `inbox/`, `results/` or `.env` is ever committed.
