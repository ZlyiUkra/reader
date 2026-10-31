# Quickstart: validating the local prototype

**Feature**: `001-local-prototype` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This guide runs the acceptance checks of the handoff (1-14) against a built prototype. It does not describe how
to build it: that is `tasks.md`. Every check is a command with an expected result (constitution, Development
Workflow). Commands run from the repository root in WSL.

## Prerequisites

- Docker Engine inside WSL with the NVIDIA Container Toolkit; `docker run --rm --gpus all <cuda image> nvidia-smi`
  shows the RTX 2070 Super.
- `.env` filled from `.env.example` (database password; inbox path, default `./inbox`). Never print it.
- Node 24 on the host only for `tsc --noEmit` outside containers; everything else runs in Compose.
- About 4 GB of free disk for the model volume and 2 GB for images.

## First start (acceptance check 2)

```sh
docker compose up -d
docker compose logs -f model-pull          # ends with exit code 0; nothing to download on a second start
curl -s http://127.0.0.1:3000/api/health   # db ok, model ready, sandbox runc, todo non-empty
```

Expected: every service `Up`; `model-pull` exited 0; health shows `"model":"ready"` after the warm-up; the browser
page at `http://127.0.0.1:3000` shows the TODO list in its header; no document is FAILED. Then
`docker compose down && docker compose up -d` downloads nothing.

## Contract test (check 1, needs the GPU)

```sh
docker compose run --rm app node --test test/ollama-contract.test.ts
```

Expected: 5 of 5 replies parse and validate against the invoice wire schema, `thinking` empty, `done_reason` `stop`.

## Sandbox and network (check 3)

```sh
docker compose exec parser sh -c 'ls /sys/class/net; id -u; touch /x'
docker inspect reader-parser-1 --format '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}'
docker network inspect reader_backend --format '{{.Internal}}'
curl --max-time 3 http://127.0.0.1:11434 ; echo "exit $?"
```

Expected: only `lo`; a non-zero uid; `touch` fails; `none true [ALL] [no-new-privileges:true] <mem>0 <pids>0`;
`true`; the curl fails (exit 7 or 28).

## Fixtures (phase 3 check)

```sh
docker compose run --rm fixtures
docker compose run --rm fixtures            # second run
ls inbox; sha256sum inbox/* | sort > /tmp/a; docker compose run --rm fixtures; sha256sum inbox/* | sort > /tmp/b; diff /tmp/a /tmp/b && echo same
```

Expected: 11 files plus `manifest.json` in the inbox, one expected file per fixture; identical hashes on every run.

## Folder run (check 4) and re-read (check 5)

In the browser: press "Read folder". Or:

```sh
curl -s -X POST -H 'Origin: http://127.0.0.1:3000' -H 'X-Reader-Request: 1' http://127.0.0.1:3000/api/inbox/read
sleep 60; curl -s http://127.0.0.1:3000/api/documents | jq '.documents[] | {number, status, type, codes: [.reasons[].code]}'
```

Expected within the run bound (`thresholds.run.bound_minutes`): 6 ACCEPTED; 3 NEEDS_REVIEW with
`MISSING_REQUIRED_FIELD`; the wrong-VAT invoice NEEDS_REVIEW with `VALIDATION_FAILED`; the untyped document
NEEDS_REVIEW with `UNKNOWN_DOC_TYPE` and no fields; every non-ACCEPTED document shows at least one rendered reason in
the browser.

Re-read: press "Read folder" again, run the generator again, copy one fixture under a new name, read again.
Expected: `count` unchanged; each repeated file in `duplicates` with `originalNumber`.

## Sensitivity class (check 6)

```sh
curl -s -X POST -H 'Origin: http://127.0.0.1:3000' -H 'X-Reader-Request: 1' -F file=@README.md http://127.0.0.1:3000/api/documents
```

Expected: `"class":"unverified"`; every fixture row shows `synthetic`. Remove the `may_leave` of one class in
`config/classes.json`, `docker compose restart app`: the app exits non-zero and names the class in its log.

## Safe reading (check 7) and hostile sizes (check 8)

```sh
docker compose run --rm app node --test test/safe-read.test.ts     # symlink, hard link, 1 GB manifest
docker compose run --rm fixtures node src/hostile.ts               # writes a 5000-page PDF and a 30000x30000 PNG into the inbox
```

Then "Read folder". Expected: the safe-read tests fail the job before anything is read or served; both hostile
documents end REJECTED `TOO_LARGE` after one attempt; `docker compose ps` shows every container still up.

## GPU-free suite (check 9)

```sh
docker compose stop model
docker compose run --rm app node --test
docker compose start model
```

Expected: all tests pass: replay pipeline tests, the status function table over all 15 codes, wire-schema
snapshots per type, manifest validation of golden parser outputs, `INTERNAL_ERROR` three times to `FAILED`.

## Registry (check 10)

```sh
cp specs/001-local-prototype/contracts/examples/receipt.v1.json schemas/   # or write a minimal receipt schema
docker compose restart app
```

Then upload any fixture copy and inspect `GET /api/documents/{number}/raw`: the classify `rawRequest` lists `receipt`.

## Model outage (check 11)

```sh
docker compose stop model; curl ... POST /api/documents (a new file); curl -s .../api/health   # model missing, document queued
docker compose start model; sleep 90; curl -s .../api/documents/{number}                      # terminal status, attempts spent during the outage: 0
```

## GPU and context (check 12)

```sh
docker compose exec model ollama ps                                                     # 100% GPU, the configured context
docker compose exec db psql -U app -d reader -c "select count(*) from extractions where done_reason <> 'stop'"   # 0 for the fixtures
```

## Host and Origin (check 13)

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://127.0.0.1:3000/api/documents          # 421
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://evil.example' http://127.0.0.1:3000/api/inbox/read   # 403
```

Expected: the codes above and an unchanged documents count.

## Evaluation (check 14, needs the GPU run of check 4)

```sh
docker compose run --rm app node src/eval.ts; echo "exit $?"
ls results/
```

Expected: every figure of the Measurement Contract printed, the line `not a tier decision`, one new JSON report in
`results/` matching `contracts/eval-report.schema.json`; exit 0 when the threshold is met (100% required fields on
the 6 ACCEPTED fixtures, 0 false accepts, under 6,000 tokens per document and 60 s per page warm), non-zero
otherwise.

## Interface language (FR-057)

Open the page: Ukrainian by default. Switch to English, reload: English stays. Clear site data: Ukrainian again.
A reason message in the table and in the detail view follows the chosen language.
