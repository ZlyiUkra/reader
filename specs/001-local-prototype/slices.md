# Slices: how the implementation runs

**Feature**: `001-local-prototype` | **Date**: 2026-10-31 | **Tasks**: [tasks.md](tasks.md)

The 76 tasks run in slices. A slice is one phase of the project dashboard (the artifact), run with
`/speckit-implement` and a task filter. Each slice section below is self-contained: the documentation servers it needs
(with the commands to start and stop them), the tasks it runs and what each one writes, the text to paste after
`/speckit-implement`, and the condition that closes it. The server lists are the ones the dashboard itself holds for
each phase, plus extras marked "+" that the tasks of the slice need and the dashboard does not list. Nothing in this
file is started by an agent: the owner starts the servers and says "yes" to each slice.

## How a slice runs

1. Start the slice's servers with its start command. Every server answers HTTP 400 on a bare request to `/mcp`, which
   means alive; the last line of the output is the free memory.
2. Say "yes". The agent (or you) runs `/speckit-implement` with the slice's Run text.
3. The agent shows the output of every check of the closing condition. A check that cannot run is not a check; if one
   fails, the slice stays open and the agent says which.
4. The tasks are marked `[X]` in tasks.md, the Agile Tasks hook updates agile-tasks.md, and the dashboard gets the
   card, the log and the finish moment and minutes of each task; a commit is prepared. The commit happens on the
   owner's word.
5. Stop the slice's servers with its stop command, unless the next slice follows at once: its start command skips a
   server that is already listening.

A slice that inherits tasks written ahead of it (slices 2 and 3) has a **Re-check first** step. Those tasks were written
in slice 0 without a recorded set of documentation servers, so the slice does not trust them: before its own tasks it
confirms that its whole server set answers and compares the inherited files with their sources.

## Order

Slice 0 is done. The order of the rest differs from the numbering in one place: **slice 2 runs before slice 1**,
because the contract test T026 of slice 1 sends the invoice wire schema that T019 of slice 2 derives from the
registry.

0 (done), then 2, 1, 3, 4, 5, 6, 7, 8, and last the cross-cutting slice.

The artifact's acceptance checks are split by what can be shown when. A check item that a slice cannot show yet is
carried to the first slice that can, and named in both places:

- "`/api/health` answers" and "the app does not start on another `schema_version`" (phase 0): slice 2, which writes
  the server and its entry point (T036).
- "port 11434 is not reachable from the host" (phase 0): slice 1, where the model container first starts.
- "`docker compose up -d` starts every service" (phase 0): slice 4, where the parser gets its server (T029).
- "hostile files end `REJECTED TOO_LARGE` after one attempt" (phase 4): slice 5, which has the queue and the status.
- "kill the app in the middle of a step and the document still ends once" (phase 5): slice 6, the first slice where a
  document reaches a terminal status.

## Slice 0 - Skeleton and networks (done, committed in 3987dea)

- **Servers** (dashboard): docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify. **+**
  jsonschema (the strict Ajv mode of T012).
- **Start set** (15): docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify, jsonschema,
  node-postgres, ollama, nvidia-container-toolkit, libreoffice, doc-tools, tesseract.
- **Tasks**:
  - T001 repository layout and `.gitignore`
  - T002 `app/package.json` with exact pins, `app/tsconfig.json`, `app/web/tsconfig.json`
  - T003 `parser/package.json` and `parser/tsconfig.json`
  - T004 `.env.example` with placeholders
  - T005 `db/init/001-role.sql` and `002-schema.sql`: tables, the role `app`, the `schema_version` row
  - T006 `app/Dockerfile`: stages `web` and `runtime` on the pinned Node image
  - T008 `compose.yaml`: services, networks, volumes, sandbox flags, GPU reservation
  - T009 `config/thresholds.json`, `config/classes.json`, `config/model.json`
  - T012 one strict Ajv instance and the contract validators (`app/src/config/ajv.ts`)
  - T013 configuration loader that refuses a class without `may_leave` (`app/src/config/load.ts`)
  - T014 database pool and the `schema_version` check (`app/src/db/`)
  - T037 the named simplifications (`app/src/config/todo.ts`)
  - T007, T010, T011 done ahead of their slices: parser image (slice 3), `config/reasons.json` and the three type
    schemas (slice 2); each is re-checked from the start when its own slice runs
- **Closed by** (all shown on 2026-10-31): `docker compose config` valid; `db` healthy with `schema_version` 1 and the
  role `app` neither superuser nor able to delete or rewrite journal tables; `reader_backend` is `internal` and the
  only published port is the UI on 127.0.0.1; the parser and fixtures images build with no Java and OCR `ukr` and
  `eng`; `tsc --noEmit` is clean for the app.

**Start the servers** (15: the work itself needs nine, a full re-check fifteen):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux owasp postgres-image postgresql typescript nodejs fastify jsonschema node-postgres ollama nvidia-container-toolkit libreoffice doc-tools tesseract" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 15; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in docker linux owasp postgres-image postgresql typescript nodejs fastify jsonschema node-postgres ollama nvidia-container-toolkit libreoffice doc-tools tesseract; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run**: not run again. To re-check the slice, ask for the closing checks above; nothing is changed.

## Slice 2 - Schema registry and reasons (next)

- **Servers** (dashboard): patterns, jsonschema, nodejs, owasp. **+** typescript; fastify and helmet (T036); docker
  (the `app` image and `docker compose run`); vite, react and mdn (T039); node-postgres (T036 wires the pool and the
  `db: ok` ping of `/api/health`).
- **Start set** (12): patterns, jsonschema, nodejs, owasp, typescript, fastify, helmet, docker, vite, react, mdn,
  node-postgres.
- **Re-check first** (T010 and T011 were written in slice 0, ahead of this slice, with no record of which servers were
  up):
  1. Before any task, confirm that all 12 servers of the start set answer: the status loop of the start command
     below, with no launch (a bare GET on `/mcp` gives 400 when alive). The agent starts nothing; if one does not
     answer, it stops and names it, and the owner starts it.
  2. Re-check T010 and T011 from the start, against their sources and not against the earlier result: read
     `config/reasons.json` and the three `schemas/*.v1.json`, and look up every claim in the source it comes from. For
     the reasons file: the 15 codes, outcome, `emitted` and `emittedBy`, trigger, params and both templates (spec
     FR-024 and C1, the `VALIDATION_FAILED` fragment template verbatim). For each type schema: the field set, the
     `x-reader` labels, `order` and `checks` (the Key Entities of the spec, `contracts/type-schema.md`,
     `data-model.md`), and the JSON Schema keywords and formats used, which the jsonschema server settles, with the
     other servers of this slice where they apply.
  3. Show a report with a row per finding: file, what was checked, the source, and the verdict (matches, differs, not
     verifiable). Change nothing; if anything differs, stop and wait for the owner, and fix only what the owner
     approves.
- **Tasks**:
  - T039 first: the front skeleton (`app/web/`: Vite config, `App.tsx`, `api.ts`, the two language files); the `web`
    stage of `app/Dockerfile` needs it and every later slice needs the `app` image
  - T017 reasons rendering and the `status()` function (`app/src/reasons/`)
  - T018 status table test over all 15 codes
  - T019 schema registry, wire schemas and the prompt template (`app/src/registry/`)
  - T020 wire-schema snapshot tests
  - T021 shared checks: EDRPOU, Ukrainian IBAN, normalisation with an offset map, value parsing (`app/src/shared/`)
  - T022 tests for the checks, normalisation, dates, money and exact VAT arithmetic
  - T036 Fastify server with the Host and Origin hook, helmet, static front, `/api/health`, `/api/meta`, and
    `app/src/main.ts` (start order: config, classes, `schema_version`, server)
  - T070 registry test with the `receipt.v1.json` example
  - T010, T011 (written in slice 0): re-checked as described above, not rewritten
- **Closes when**:
  1. `docker compose build app` succeeds and `docker compose run --rm app node --test` is green with no GPU: the
     status table over all 15 codes, the wire-schema snapshots, the checks and normalisation tests, the registry test.
  2. `docker compose up -d db app`: `GET /api/health` answers with `db: ok`, `model: missing`, `sandbox: runc` and 12
     `todo` entries; `GET /api/meta` lists the three types and the reasons.
  3. `receipt.v1.json` copied into `schemas/` and `app` restarted: `GET /api/meta` lists `receipt`; removed
     afterwards.
  4. One class without `may_leave`: `app` exits non-zero and names the class.
  5. A changed schema version: `app` refuses to start and says so.
  6. The `app` container has no capabilities: `docker compose exec app grep -E 'CapEff|NoNewPrivs' /proc/1/status`
     shows `CapEff` all zero and `NoNewPrivs` 1.
  7. The re-check report of T010 and T011 is shown, with every difference listed and each one fixed with the owner's
     approval or accepted in writing.

**Start the servers** (12):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="patterns jsonschema nodejs owasp typescript fastify helmet docker vite react mdn node-postgres" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 12; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in patterns jsonschema nodejs owasp typescript fastify helmet docker vite react mdn node-postgres; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 2 only. Step 0, before any task: confirm that all 12 servers of this slice answer, using the status loop of the
start command without launching anything (a bare GET on /mcp gives 400); if one does not answer, stop and name it.
Then re-check T010 and T011, written ahead in slice 0, from the start against spec FR-024, C1,
contracts/type-schema.md, data-model.md and the servers of this slice; show a report with a row per finding (file,
what was checked, source, matches / differs / not verifiable); change nothing, and if anything differs stop and wait
for my answer. Then run first T039, then T017, T018, T019, T020, T021, T022, T036, T070. Do not start any other task.
T036 also writes app/src/main.ts. Finish with the slice 2 closing checks and show their output: docker compose build
app; docker compose run --rm app node --test with no GPU; docker compose up -d db app, then GET /api/health and
/api/meta; receipt.v1.json copied into schemas/ and app restarted, then removed; a class without may_leave; a
changed schema_version; CapEff and NoNewPrivs of the app container; the re-check report. Mark each finished task [X]
in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 1 - Model and contract

- **Servers** (dashboard): docker, ollama, fastify, nodejs, typescript, patterns, jsonschema. **+**
  nvidia-container-toolkit (the GPU reaches the container through it; slice 1 is the first to need it).
- **Start set** (8): docker, ollama, fastify, nodejs, typescript, patterns, jsonschema, nvidia-container-toolkit.
- **Tasks**:
  - T023 LLM port and dispatcher: class gate, context budget (`app/src/llm/`)
  - T024 Ollama adapter: `/api/chat`, fallbacks, readiness from `/api/tags`, `/api/ps` and a warm-up call
  - T025 replay adapter that serves stored recordings
  - T026 contract test: five calls with the invoice wire schema, skipped unless `MODEL_URL` is set; needs T019 of
    slice 2
  - T067 pull the model once, pin its digest in `config/model.json`, wire the readiness into `/api/health`
- **Closes when** (needs the GPU): the contract test passes 5 of 5 (valid JSON, empty `thinking`, `done_reason`
  `stop`; quickstart check 1); `ollama ps` shows 100% GPU and a context of 16384; a second `up` downloads nothing
  (check 2, second half); port 11434 is not reachable from the host (check 3, port half); `app` reaches
  `http://model:11434/api/version` by name over the backend network; `model` has no capabilities (`CapEff` zero) and
  still logs the CUDA device; `/api/health` reports `model: ready` only with the pinned digest in `config/model.json`.

**Start the servers** (8):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker ollama fastify nodejs typescript patterns jsonschema nvidia-container-toolkit" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 8; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in docker ollama fastify nodejs typescript patterns jsonschema nvidia-container-toolkit; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 1 only: T023, T024, T025, T026, T067. Do not start any other task. The GPU is needed. Finish with the slice 1
closing checks and show their output: the contract test 5 of 5 with MODEL_URL set; ollama ps (100% GPU, context
16384); a second up downloads nothing; port 11434 not reachable from the host; app reaches
http://model:11434/api/version by name; CapEff of the model container and the CUDA line in its log; /api/health
reports model ready only with the pinned digest. Mark each finished task [X] in tasks.md. Then run the
after_implement hook (agile-tasks).
```

## Slice 3 - Synthetic documents

- **Servers** (dashboard): docker, linux, libreoffice, doc-tools, nodejs, patterns. **+** typescript; jsonschema (the
  expected values are instances of the type schemas); tesseract (the scanned fixtures must still OCR to their expected
  values); mdn (the HTML templates).
- **Start set** (10): docker, linux, libreoffice, doc-tools, nodejs, patterns, typescript, jsonschema, tesseract, mdn.
- **Re-check first** (T007 was written in slice 0, ahead of this slice, with no record of which servers were up):
  1. Before any task, confirm that all 10 servers of the start set answer: the status loop of the start command
     below, with no launch (a bare GET on `/mcp` gives 400 when alive). The agent starts nothing; if one does not
     answer, it stops and names it, and the owner starts it.
  2. Re-check T007 from the start, against its sources and not against the earlier result: read `parser/Dockerfile`
     and look up every claim in the source it comes from. The base image and its digest; each pinned apt package
     and version against research R4 and the bookworm package pages; `--no-install-recommends` and no Java; user
     `10001`; the `parser` and `fixtures` targets and what `fixtures` copies; and the options the Dockerfile and the
     later tasks rely on (LibreOffice headless conversion, poppler, Tesseract `ukr+eng`, rsvg, `file`, qpdf), which the
     docker, linux, libreoffice, doc-tools and tesseract servers settle.
  3. Show a report with a row per finding: file, what was checked, the source, and the verdict (matches, differs, not
     verifiable). Change nothing; if anything differs, stop and wait for the owner, and fix only what the owner
     approves.
- **Tasks**:
  - T032 three fictional companies with valid EDRPOU and IBAN, and the fixed data object of the 11 documents
  - T033 Ukrainian HTML templates of the three types
  - T034 the generator: PDF, DOCX, DOC, RTF, XLSX, scans, PNG, JPG, SVG, byte-stable, with the manifest and the
    expected values
  - T035 the hostile set (5000-page PDF, 30000 x 30000 PNG, encrypted, truncated, zip, blank, noise), written on
    demand
  - T007 (written in slice 0): re-checked as described above, not rewritten
- **Closes when**: two generator runs give the same sha256 list; the inbox holds 11 files, `manifest.json` and one
  `expected/<sha256>.json` per fixture; the hostile set writes on demand and is not listed in the manifest; the
  re-check report of T007 is shown, with every difference listed and each one fixed with the owner's approval or
  accepted in writing.

**Start the servers** (10):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux libreoffice doc-tools nodejs patterns typescript jsonschema tesseract mdn" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 10; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in docker linux libreoffice doc-tools nodejs patterns typescript jsonschema tesseract mdn; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 3 only. Step 0, before any task: confirm that all 10 servers of this slice answer, using the status loop of the
start command without launching anything (a bare GET on /mcp gives 400); if one does not answer, stop and name it.
Then re-check T007, written ahead in slice 0, from the start: parser/Dockerfile against research R4, the Debian
bookworm package pages and the servers of this slice; show a report with a row per finding (file, what was checked,
source, matches / differs / not verifiable); change nothing, and if anything differs stop and wait for my answer. Then
run T032, T033, T034, T035 and do not start any other task. Finish with the slice 3 closing checks and show their
output: two generator runs give the same sha256 list; the inbox holds 11 files, manifest.json and one
expected/<sha256>.json per fixture; the hostile set is written on demand and is not listed in the manifest; the
re-check report. Mark each finished task [X] in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 4 - Sandbox and parsing

- **Servers** (dashboard): docker, linux, owasp, nodejs, doc-tools, libreoffice, tesseract, jsonschema. **+**
  typescript.
- **Start set** (9): docker, linux, owasp, nodejs, doc-tools, libreoffice, tesseract, jsonschema, typescript.
- **Tasks**:
  - T027 tool wrappers with process groups, timeouts and memory limits (`parser/src/tools/`)
  - T028 `parser/src/parse.ts`: routing by type, page and size checks, OCR rule, previews, reason mapping,
    `manifest.json` last
  - T029 `parser/src/server.ts`: HTTP on `/jobs/parser.sock`, created with mode `0660`; one job at a time, a fresh
    child per job
  - T030 app side: parser client and the safe reader (`lstat`, `O_NOFOLLOW`, `nlink`, size caps, PNG check, manifest
    validation)
  - T031 tests for the safe reader and the manifest (symlink, hard link, 1 GB manifest, extra key)
- **Closes when**: the parser container has only the `lo` interface, a non-zero uid and a read-only root; each of the
  11 fixtures parses to a manifest that validates, and those outputs are saved as golden files; the safe-read tests
  fail the job for a symlink, a hard link and a 1 GB manifest with nothing read (check 7); the parser answers
  `TOO_LARGE` for the 5000-page PDF and the 30000 x 30000 PNG; the app (uid 1000, group 10001) can connect to
  `/jobs/parser.sock`, which is created with mode `0660`; `docker compose up -d` starts every service.

**Start the servers** (9):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux owasp nodejs doc-tools libreoffice tesseract jsonschema typescript" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 9; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in docker linux owasp nodejs doc-tools libreoffice tesseract jsonschema typescript; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 4 only: T027, T028, T029, T030, T031. Do not start any other task. Finish with the slice 4 closing checks and
show their output: the parser container has only the lo interface, a non-zero uid and a read-only root; each of the
11 fixtures parses to a valid manifest and the outputs are saved as golden files; the safe-read tests fail the job
for a symlink, a hard link and a 1 GB manifest; the parser answers TOO_LARGE for the 5000-page PDF and the 30000 x
30000 PNG; the app can connect to /jobs/parser.sock; docker compose up -d starts every service. Mark each finished
task [X] in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 5 - Intake and queue

- **Servers** (dashboard): postgresql, node-postgres, nodejs, linux, fastify, owasp. **+** typescript; docker;
  patterns (the claim loop and the worker, T016 and T038).
- **Start set** (9): postgresql, node-postgres, nodejs, linux, fastify, owasp, typescript, docker, patterns.
- **Tasks**:
  - T015 parameterised queries and the transaction helper (`app/src/db/`)
  - T016 claim with `SELECT ... FOR UPDATE SKIP LOCKED`, lease, finish, requeue, boot requeue
  - T038 the worker: claim loop, step dispatch, no model claim while the model is missing
  - T041 inbox intake: listing, hashing, class rule, duplicate detection, blob store, `RECEIVED` rows
  - T042 `GET /inbox` and `POST /inbox/read`
  - T043 parse step: job id, call the parser, safe read, store pages and texts, status change in one transaction
  - T048 failure mapping to reason codes, three attempts, lease expiry (`app/src/pipeline/failures.ts`)
  - T059 upload route with `@fastify/multipart`, streamed under the sha256
  - T061 run quickstart check 6 and the duplicate upload; fix findings
  - T068 requeue test and the manual kill-the-app check
- **Closes when**: check 5 (two "Read folder" runs, regenerated fixtures and a renamed copy leave the document count
  unchanged and answer `DUPLICATE` with the original's number); check 6 (a file outside the manifest is `unverified`,
  every fixture is `synthetic`, a class without a rule stops the app); check 8 (the hostile files end `REJECTED
  TOO_LARGE` after one attempt and every container stays up); the requeue test passes against the real PostgreSQL;
  three `INTERNAL_ERROR` end in `FAILED`. Documents that need the model wait at `CLASSIFY`.

**Start the servers** (9):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="postgresql node-postgres nodejs linux fastify owasp typescript docker patterns" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 9; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in postgresql node-postgres nodejs linux fastify owasp typescript docker patterns; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 5 only: T015, T016, T038, T041, T042, T043, T048, T059, T061, T068. Do not start any other task. Finish with
the slice 5 closing checks and show their output: quickstart check 5 (two Read folder runs, regenerated fixtures and
a renamed copy leave the document count unchanged and answer DUPLICATE); check 6; check 8 (hostile files end
REJECTED TOO_LARGE after one attempt, every container stays up); the requeue test against the real PostgreSQL; three
INTERNAL_ERROR end in FAILED; documents that need the model wait at CLASSIFY. Mark each finished task [X] in
tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 6 - Recognition and checks

- **Servers** (dashboard): nodejs, ollama, jsonschema, postgresql, node-postgres. **+** typescript; mdn (Unicode
  normalisation, `Intl` and date parsing in T046 and T047); docker (T052 runs against the real `db` service, T053 on
  the whole stack).
- **Start set** (8): nodejs, ollama, jsonschema, postgresql, node-postgres, typescript, mdn, docker.
- **Tasks**:
  - T044 classify step (`app/src/pipeline/classify.ts`)
  - T045 extract step with the budget check and `done_reason: length` handling
  - T046 evidence: locate every fragment in the page texts, derive typed values, write `fields`
  - T047 checks step: registry checks, reasons, final status in one transaction
  - T052 record the fixtures run once with the GPU, golden outputs, the replay pipeline test
  - T053 run quickstart checks 4, 5 and 11 on the real stack; fix findings
- **Closes when** (needs the GPU): check 4 ("Read folder": 6 `ACCEPTED`, 3 `NEEDS_REVIEW` with
  `MISSING_REQUIRED_FIELD`, the wrong-VAT invoice `VALIDATION_FAILED`, the untyped document `UNKNOWN_DOC_TYPE` with no
  fields, a rendered reason on every document that is not accepted); check 5 again; check 11 (model stopped: documents
  wait, no attempt spent); the live kill-the-app-mid-step check of T068; replay recordings saved and `node --test`
  green with the model stopped (check 9).

**Start the servers** (8):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="nodejs ollama jsonschema postgresql node-postgres typescript mdn docker" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 8; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in nodejs ollama jsonschema postgresql node-postgres typescript mdn docker; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 6 only: T044, T045, T046, T047, T052, T053. Do not start any other task. The GPU is needed. Finish with the
slice 6 closing checks and show their output: quickstart check 4 (6 ACCEPTED, 3 NEEDS_REVIEW with
MISSING_REQUIRED_FIELD, the wrong-VAT invoice VALIDATION_FAILED, the untyped document UNKNOWN_DOC_TYPE, a rendered
reason on every document that is not accepted); check 5 again; check 11 (model stopped, documents wait, no attempt
spent); the live kill-the-app-mid-step check; node --test green with the model stopped. Mark each finished task [X]
in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 7 - Interface

- **Servers** (dashboard): react, vite, fastify, mdn, frontend-architecture, owasp, helmet. **+** typescript; nodejs
  (`node:test` for T040); node-postgres (the detail routes read the database); docker and ollama (T069 runs checks 2,
  3 and 8 on the stack).
- **Start set** (12): react, vite, fastify, mdn, frontend-architecture, owasp, helmet, typescript, nodejs,
  node-postgres, docker, ollama.
- **Tasks**:
  - T040 i18n test: equal key sets, every label and reason template in uk and en
  - T049 `GET /documents` list
  - T050 Inbox view: file list, Read folder, result
  - T051 Documents view: table polled every 2 seconds
  - T054 `GET /documents/{number}` with fields, evidence, pages, steps
  - T055 `GET /documents/{number}/raw`
  - T056 page PNG route, `nosniff`, no endpoint for originals
  - T057 Document view: fields with fragments, lazy pages, steps, reasons as text, collapsed raw block
  - T058 verify in the browser that no document text is rendered as HTML; fix findings
  - T060 upload control in the Inbox view
  - T066 Header: model state, sandbox runtime, TODO list, language switch
  - T069 run quickstart checks 2, 3, 8, 13 and the two refusals of SC-009; fix findings
- **Closes when**: a foreign `Host` or `Origin` gets 403 or 421 and changes nothing (check 13); the header shows the
  TODO list; every field in the detail view shows its fragment and page; checks 2, 3 and 8 pass in the browser and
  from the host; the language check of FR-057 passes; the two refusals of SC-009 pass.

**Start the servers** (12):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="react vite fastify mdn frontend-architecture owasp helmet typescript nodejs node-postgres docker ollama" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 12; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in react vite fastify mdn frontend-architecture owasp helmet typescript nodejs node-postgres docker ollama; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 7 only: T040, T049, T050, T051, T054, T055, T056, T057, T058, T060, T066, T069 (T039 is already done). Do not
start any other task. Finish with the slice 7 closing checks and show their output: a foreign Host or Origin gets
403 or 421 and changes nothing (check 13); the header shows the TODO list; every field in the detail view shows its
fragment and page; checks 2, 3 and 8; the FR-057 language check; the two refusals of SC-009. Mark each finished task
[X] in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Slice 8 - Measurement

- **Servers** (dashboard): patterns, docker, nodejs. **+** typescript; ollama (check 12 reads `ollama ps`); jsonschema
  (the report shape is the contract `eval-report.schema.json`); node-postgres and postgresql (the eval reads the
  database, check 12 queries `done_reason`).
- **Start set** (8): patterns, docker, nodejs, typescript, ollama, jsonschema, node-postgres, postgresql.
- **Tasks**:
  - T062 `app/src/eval.ts`: match, false accepts, reason shares, time and tokens, text and JSON report
  - T063 eval tests on a replayed run and on a changed amount
  - T064 run check 14 on the real run; create the measurement journal in `README.md` with its first row
  - T065 run checks 9 and 12; fix findings
- **Closes when** (needs the GPU): check 14 (the eval prints every figure of the Measurement Contract, writes one JSON
  report in `results/`, prints "not a tier decision" and exits non-zero below the written threshold); the first row of
  the measurement journal is in the README; checks 9 and 12 pass.

**Start the servers** (8):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="patterns docker nodejs typescript ollama jsonschema node-postgres postgresql" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 8; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in patterns docker nodejs typescript ollama jsonschema node-postgres postgresql; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Slice 8 only: T062, T063, T064, T065. Do not start any other task. The GPU is needed. Finish with the slice 8
closing checks and show their output: check 14 (the eval prints every figure of the Measurement Contract, writes one
JSON report in results/, prints not a tier decision and exits non-zero below the written threshold); the first row
of the measurement journal in README.md; checks 9 and 12. Mark each finished task [X] in tasks.md. Then run the
after_implement hook (agile-tasks).
```

## Cross-cutting - Polish and the live registry check

- **Servers**: owasp (the secrets and logging reviews); docker, nodejs, typescript; jsonschema (check 10). T076 runs
  the whole quickstart, so start the full set of the last section.
- **Start set** (21): docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify, ollama, patterns,
  jsonschema, libreoffice, doc-tools, tesseract, node-postgres, react, vite, mdn, frontend-architecture, helmet,
  nvidia-container-toolkit.
- **Tasks**:
  - T071 run quickstart check 10 live: a new type file, restart, a new upload; remove the example afterwards
  - T072 `README.md`: how to run, where the reports land
  - T073 secrets review of the repository
  - T074 logging review of `app/src/`
  - T075 todo test: every row of the spec table is in `config/todo.ts`, the WARN output and `/health`
  - T076 run the whole quickstart, checks 1 to 14 and the language check, and record the outcome
- **Closes when**: the whole quickstart, checks 1 to 14 and the language check, has run with its outcome recorded at
  the end of quickstart.md; the secrets and logging reviews find nothing; the todo test passes; check 10 passes live.

**Start the servers** (21: the quickstart touches every service):

```sh
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

**Stop the servers** (the same 21; skip it when the next slice follows at once):

```sh
cd ~/Projects/docfactory && for n in docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```

**Run** (type `/speckit-implement`, then paste):

```text
Cross-cutting slice only: T071, T072, T073, T074, T075, T076. Do not start any other task. The GPU is needed. Finish
with the closing checks and show their output: the whole quickstart (checks 1 to 14 and the language check) with its
outcome recorded at the end of quickstart.md; the secrets and logging reviews find nothing; the todo test passes;
check 10 passes live. Mark each finished task [X] in tasks.md. Then run the after_implement hook (agile-tasks).
```

## Deferred (dashboard phase 9)

No slice. Each item starts when its trigger fires, with its own acceptance check: gvisor, invisible-text stripping,
the malware scan, the Claude adapter, the review form and bounding boxes, Kubernetes, migrations, the model baked into
the image, the label-proximity rule. Their documentation servers (gvisor, kubernetes and the one for the cloud model)
are not part of any slice.

## All servers at once

All 21 servers the slices above name: docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify,
ollama, patterns, jsonschema, libreoffice, doc-tools, tesseract, node-postgres, react, vite, mdn,
frontend-architecture, helmet, nvidia-container-toolkit. The ports are read from each instance's `config.json` in
`~/Projects/docfactory`, so this list never carries a port. Use it for the cross-cutting slice or to bring up
everything in one go.

```sh
# start (skips a server that is already listening)
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

```sh
# stop (by port, TERM; touches nothing else)
cd ~/Projects/docfactory && for n in docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```
