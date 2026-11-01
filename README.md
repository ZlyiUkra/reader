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

## The page

The browser page lives in `app/web/src`. Its modules by role:

- `main.tsx` starts React; `App.tsx` is the shell: the header, the four tabs and the view the address names.
- `router.ts` reads and sets the address (`#/folder`, `#/folder/<file>`, `#/documents`, `#/documents/<number>`,
  `#/types`, `#/simplifications`) and keeps the address bar in order: the empty address goes to the default page (the
  folder), and any other, a hash or a path, becomes `#/_404/<the address as typed>`, the not-found page; `pager.ts` keeps the paging of both lists; `theme.ts` the light and dark themes.
- `api/` is the only door to the server: `client.ts` (requests), `usePolledAnswer.ts` (the one way a view fetches and
  polls), `shapes.ts` (readers that narrow what arrives) and `answers.ts` (the type and parser of every answer).
- `i18n/` holds the two dictionaries (`uk.json`, `en.json`), `t.ts` (looking a text up), `display.ts` (labels, reason
  messages, values and times built from what the server sends) and `errors.ts`.
- `views/` has one file per tab (`Inbox.tsx`, `Documents.tsx`, `Types.tsx`, `Simplifications.tsx`) and `NotFound.tsx`; `components/` the
  parts they share (`Window.tsx`, `DocumentCard.tsx`, `FileNote.tsx`, `Upload.tsx`, `Pager.tsx`, `NewVersion.tsx`,
  `ReasonList.tsx`, `StatusBadge.tsx`) and the header (`Header.tsx`), whose row of state indicators (DB, LLM, PRS, the
  sandbox runtime and TODO with its count) and two buttons are of one size, each with a tooltip.
- `@shared/<module>.ts` is code the page shares with the server (`app/src/shared`): the pager arithmetic, the routes,
  the text formatter. Field labels, field order and reason messages are not in the page: they come from `/api/meta`.

## Running it

Everything runs in containers, from the repository root. Nothing is installed on the host except Docker.

What you need:

- Linux, or Windows with WSL2, with Docker Engine and the Docker Compose v2 plugin (`docker compose`). The prototype
  was built and checked on WSL2 with Docker Engine only; other setups were not tried.
- An NVIDIA GPU and the NVIDIA Container Toolkit: the `model` service reserves one GPU. The prototype was measured on
  an RTX 2070 Super with 8 GB; other cards were not tried. Without a GPU the model does not start; the tests (step 8)
  need no GPU.
- A network and free disk for the first start: the images are built and pulled, and the model weights are downloaded
  once into a volume (one layer of about 2.6 GB, as recorded in check 2 of the quickstart). The total size and the
  build time were not measured.

Steps:

1. Clone the repository and enter it: `git clone <repository address> reader && cd reader`.
2. `cp .env.example .env`. Put two long random values in `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` (for example the
   output of `openssl rand -hex 24`) and the output of `id -u` and `id -g` in `READER_UID` and `READER_GID`. The other
   values can stay. `.env` is never committed and never printed.
3. `docker compose up -d` builds the parser and the app images, pulls the database and model images and starts the
   database, the model, the parser sandbox and the app. The first start also downloads the model
   (`docker compose logs -f model-pull` is the progress view); later starts download nothing. The app starts at once
   and takes no model work until the model is ready.
4. Wait until `curl -s http://127.0.0.1:3000/api/health` reports `"db":"ok"`, `"model":"ready"` and `"parser":"ok"`.
   The page header shows the same as the DB, LLM and PRS indicators.
5. `docker compose run --rm fixtures` writes the synthetic documents, their manifest and the expected values into
   `inbox/`, which is empty after a clone. The files are byte-identical on every run.
6. Open `http://127.0.0.1:3000` and press "Read folder". The page polls every two seconds; it is Ukrainian by default
   and switches to English in the header. A file can also be uploaded from the page.
7. `docker compose run --rm app node src/eval.ts` evaluates the stored run against the expected values. It prints
   every figure, says "not a tier decision", exits non-zero below the thresholds and writes one JSON report into
   `results/`, named by the run date, time and model digest. Each report is a source for a row of the measurement
   journal below.
8. `docker compose run --rm app node --test` runs the tests and needs the database service up; stop the model first
   (`docker compose stop model`) to prove they need no GPU.
9. `docker compose down` stops everything and keeps the data. `docker compose down -v` also deletes the database and
   the model volume: it is the one agreed reset, for a change of the database schema.

The page is published on 127.0.0.1 only (`READER_PORT` changes the port); the database and the model are not published
at all. The named simplifications of the prototype, each with what ends it, are the `todo` list of `GET /api/health`,
the TODO count in the page header, the list at `#/simplifications` and one WARN line each at start. The acceptance
checks are in `specs/001-local-prototype/quickstart.md`, with the outcome of their last full run at its end.

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

Git since 2026-10-31, branch `main`. Everything is tracked except `.claude/`, `.specify/`, `AGENTS.md`, `.env`, and the
contents of `inbox/` and `results/`; the first three exist only on the owner's machine.
