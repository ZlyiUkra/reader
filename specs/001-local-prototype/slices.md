# Slices: how the implementation runs

**Feature**: `001-local-prototype` | **Date**: 2026-10-31 | **Tasks**: [tasks.md](tasks.md)

The 76 tasks run in slices. A slice is one phase of the project dashboard (the artifact), run with
`/speckit-implement` and a task filter. This file is the single source for three things per slice: the documentation
servers to start before it, the tasks it runs, and the condition that closes it. The server lists are the ones the
dashboard itself holds for each phase, plus extras marked "+" that the tasks of the slice need and the dashboard does
not list. Nothing in this file is started by an agent: the owner starts the servers and says "yes" to each slice.

## How a slice runs

1. The owner starts the documentation servers of the slice (the commands are in the last section).
2. The owner says "yes"; the agent runs `/speckit-implement` with the slice's task filter and the closing condition.
3. The agent shows the output of every check of the closing condition. A check that cannot run is not a check; if one
   fails, the slice stays open and the agent says which.
4. The tasks are marked `[X]` in tasks.md, the Agile Tasks hook updates agile-tasks.md, the dashboard cards and the
   log are updated, and a commit is prepared. The commit happens on the owner's word.

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

## Slice 0 - Skeleton and networks (done, not committed)

- **Servers** (dashboard): docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify. **+**
  jsonschema (the strict Ajv mode of T012).
- **Tasks**: T001-T006, T008, T009, T012, T013, T014, T037. Done ahead of their own slices: T007 (slice 3), T010 and
  T011 (slice 2).
- **Closed by** (all shown on 2026-10-31): `docker compose config` valid; `db` healthy with `schema_version` 1 and the
  role `app` neither superuser nor able to delete or rewrite journal tables; `reader_backend` is `internal` and the
  only published port is the UI on 127.0.0.1; the parser and fixtures images build with no Java and OCR `ukr` and
  `eng`; `tsc --noEmit` is clean for the app.

## Slice 2 - Schema registry and reasons (next)

- **Servers** (dashboard): patterns, jsonschema, nodejs, owasp. **+** typescript; fastify and helmet (T036); docker
  (the `app` image and `docker compose run`); vite, react and mdn (T039); node-postgres (T036 wires the pool and the
  `db: ok` ping of `/api/health`).
- **Tasks**: T039 first, because the `web` stage of `app/Dockerfile` needs it and every later slice needs the `app`
  image; then T017, T018, T019, T020, T021, T022, T036, T070. T036 now also writes `app/src/main.ts`, so the app can
  start.
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

## Slice 1 - Model and contract

- **Servers** (dashboard): docker, ollama, fastify, nodejs, typescript, patterns, jsonschema. **+**
  nvidia-container-toolkit (the GPU reaches the container through it; slice 1 is the first to need it).
- **Tasks**: T023, T024, T025, T026, T067. T067 also wires the Ollama readiness into `/api/health`.
- **Closes when** (needs the GPU): the contract test passes 5 of 5 (valid JSON, empty `thinking`, `done_reason`
  `stop`; quickstart check 1); `ollama ps` shows 100% GPU and a context of 16384; a second `up` downloads nothing
  (check 2, second half); port 11434 is not reachable from the host (check 3, port half); `app` reaches
  `http://model:11434/api/version` by name over the backend network; `model` has no capabilities (`CapEff` zero) and
  still logs the CUDA device; `/api/health` reports `model: ready` only with the pinned digest in `config/model.json`.

## Slice 3 - Synthetic documents

- **Servers** (dashboard): docker, linux, libreoffice, doc-tools, nodejs, patterns. **+** typescript; jsonschema (the
  expected values are instances of the type schemas); tesseract (the scanned fixtures must still OCR to their expected
  values); mdn (the HTML templates).
- **Tasks**: T032, T033, T034, T035 (T007 done).
- **Closes when**: two generator runs give the same sha256 list; the inbox holds 11 files, `manifest.json` and one
  `expected/<sha256>.json` per fixture; the hostile set writes on demand and is not listed in the manifest.

## Slice 4 - Sandbox and parsing

- **Servers** (dashboard): docker, linux, owasp, nodejs, doc-tools, libreoffice, tesseract, jsonschema. **+**
  typescript.
- **Tasks**: T027, T028, T029, T030, T031.
- **Closes when**: the parser container has only the `lo` interface, a non-zero uid and a read-only root; each of the
  11 fixtures parses to a manifest that validates, and those outputs are saved as golden files; the safe-read tests
  fail the job for a symlink, a hard link and a 1 GB manifest with nothing read (check 7); the parser answers
  `TOO_LARGE` for the 5000-page PDF and the 30000 x 30000 PNG; the app (uid 1000, group 10001) can connect to
  `/jobs/parser.sock`, which is created with mode `0660`; `docker compose up -d` starts every service.

## Slice 5 - Intake and queue

- **Servers** (dashboard): postgresql, node-postgres, nodejs, linux, fastify, owasp. **+** typescript; docker;
  patterns (the claim loop and the worker, T016 and T038).
- **Tasks**: T015, T016, T038, T041, T042, T043, T048, T059, T061, T068.
- **Closes when**: check 5 (two "Read folder" runs, regenerated fixtures and a renamed copy leave the document count
  unchanged and answer `DUPLICATE` with the original's number); check 6 (a file outside the manifest is `unverified`,
  every fixture is `synthetic`, a class without a rule stops the app); check 8 (the hostile files end `REJECTED
  TOO_LARGE` after one attempt and every container stays up); the requeue test passes against the real PostgreSQL;
  three `INTERNAL_ERROR` end in `FAILED`. Documents that need the model wait at `CLASSIFY`.

## Slice 6 - Recognition and checks

- **Servers** (dashboard): nodejs, ollama, jsonschema, postgresql, node-postgres. **+** typescript; mdn (Unicode
  normalisation, `Intl` and date parsing in T046 and T047); docker (T052 runs against the real `db` service, T053 on
  the whole stack).
- **Tasks**: T044, T045, T046, T047, T052, T053.
- **Closes when** (needs the GPU): check 4 ("Read folder": 6 `ACCEPTED`, 3 `NEEDS_REVIEW` with
  `MISSING_REQUIRED_FIELD`, the wrong-VAT invoice `VALIDATION_FAILED`, the untyped document `UNKNOWN_DOC_TYPE` with no
  fields, a rendered reason on every document that is not accepted); check 5 again; check 11 (model stopped: documents
  wait, no attempt spent); the live kill-the-app-mid-step check of T068; replay recordings saved and `node --test`
  green with the model stopped (check 9).

## Slice 7 - Interface

- **Servers** (dashboard): react, vite, fastify, mdn, frontend-architecture, owasp, helmet. **+** typescript; nodejs
  (`node:test` for T040); node-postgres (the detail routes read the database); docker and ollama (T069 runs checks 2,
  3 and 8 on the stack).
- **Tasks**: T040, T049, T050, T051, T054, T055, T056, T057, T058, T060, T066, T069 (T039 done in slice 2).
- **Closes when**: a foreign `Host` or `Origin` gets 403 or 421 and changes nothing (check 13); the header shows the
  TODO list; every field in the detail view shows its fragment and page; checks 2, 3 and 8 pass in the browser and
  from the host; the language check of FR-057 passes; the two refusals of SC-009 pass.

## Slice 8 - Measurement

- **Servers** (dashboard): patterns, docker, nodejs. **+** typescript; ollama (check 12 reads `ollama ps`); jsonschema
  (the report shape is the contract `eval-report.schema.json`); node-postgres and postgresql (the eval reads the
  database, check 12 queries `done_reason`).
- **Tasks**: T062, T063, T064, T065.
- **Closes when** (needs the GPU): check 14 (the eval prints every figure of the Measurement Contract, writes one JSON
  report in `results/`, prints "not a tier decision" and exits non-zero below the written threshold); the first row of
  the measurement journal is in the README; checks 9 and 12 pass.

## Cross-cutting - Polish and the live registry check

- **Servers**: owasp (the secrets and logging reviews); docker, nodejs, typescript; jsonschema (check 10). T076 runs
  the whole quickstart, so start the full set of the last section.
- **Tasks**: T071, T072, T073, T074, T075, T076.
- **Closes when**: the whole quickstart, checks 1 to 14 and the language check, has run with its outcome recorded at
  the end of quickstart.md; the secrets and logging reviews find nothing; the todo test passes; check 10 passes live.

## Deferred (dashboard phase 9)

No slice. Each item starts when its trigger fires, with its own acceptance check: gvisor, invisible-text stripping,
the malware scan, the Claude adapter, the review form and bounding boxes, Kubernetes, migrations, the model baked into
the image, the label-proximity rule. Their documentation servers (gvisor, kubernetes and the one for the cloud model)
are not part of any slice.

## Servers to start

All 21 servers the slices above name: docker, linux, owasp, postgres-image, postgresql, typescript, nodejs, fastify,
ollama, patterns, jsonschema, libreoffice, doc-tools, tesseract, node-postgres, react, vite, mdn,
frontend-architecture, helmet, nvidia-container-toolkit. The ports are read from each instance's `config.json` in
`~/Projects/docfactory`, so this list never carries a port.

```sh
# start (skips a server that is already listening)
cd ~/Projects/docfactory && mkdir -p /tmp/df-all && S="docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit" && for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); if ss -ltnH "sport = :$p" | grep -q .; then echo "already up  $n ($p)"; else nohup ./df "$n" serve >"/tmp/df-all/$n.log" 2>&1 </dev/null & echo "starting    $n ($p)"; fi; done; sleep 25; for n in $S; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); printf '%-26s %-6s ' "$n" "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 "http://127.0.0.1:$p/mcp"; done; free -g | sed -n '2p'
```

```sh
# stop (by port, TERM; touches nothing else)
cd ~/Projects/docfactory && for n in docker linux owasp postgres-image postgresql typescript nodejs fastify ollama patterns jsonschema libreoffice doc-tools tesseract node-postgres react vite mdn frontend-architecture helmet nvidia-container-toolkit; do p=$(python3 -c "import json;print(json.load(open('instances/$n/config.json'))['port'])"); pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); if [ -n "$pid" ]; then kill "$pid" && echo "stopped  $n ($p, pid $pid)"; else echo "not running $n ($p)"; fi; done
```
