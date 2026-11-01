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
page at `http://127.0.0.1:3000` shows the TODO count in its header and the list at `#/simplifications`; no document is FAILED. Then
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
ls inbox; find inbox -type f -exec sha256sum {} + | sort > /tmp/a; docker compose run --rm fixtures; find inbox -type f -exec sha256sum {} + | sort > /tmp/b; diff /tmp/a /tmp/b && echo same
```

Expected: 11 files plus `manifest.json` at the top level of the inbox, one expected file per fixture in
`inbox/expected/`; identical hashes on every run.

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
docker compose run --rm fixtures node fixtures/hostile.ts               # the hostile set of T035 into the inbox: two oversized files plus one file per parser reason code
```

Then "Read folder". Expected: the safe-read tests fail the job before anything is read or served; the two oversized
documents end REJECTED `TOO_LARGE` after one attempt; the password-protected PDF ends REJECTED `ENCRYPTED`, the
truncated DOCX `CORRUPT`, the `.zip` `UNSUPPORTED_FORMAT`; the blank-page PDF ends NEEDS_REVIEW `EMPTY` and the
noise-only PNG NEEDS_REVIEW `LOW_OCR_QUALITY`; `docker compose ps` shows every container still up.

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
cp app/test/fixtures/registry/receipt.v1.json schemas/   # a minimal fourth type; schemas/ is a bind mount of app
docker compose restart app
cp inbox/<a text PDF fixture> /tmp/receipt-probe.pdf && printf ' ' >> /tmp/receipt-probe.pdf   # a new content hash
```

Then upload `/tmp/receipt-probe.pdf` (a fixture copy itself is a `DUPLICATE` and runs no classification) and inspect
`GET /api/documents/{number}/raw`: the classify `rawRequest` lists `receipt`. Remove the file from `schemas/`
afterwards.

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

## Outcome of the last full run (T076, 2026-11-01, 03:55-04:05 UTC)

All fourteen checks and the language check ran against the stack built from the committed code plus the slice
"Polish" changes. Every check passed as a command; check 14 exits 1 because the measured figures are below the
thresholds, which is its specified behaviour (the first row of the journal in `README.md`).

- Check 1, contract test: 5 of 5 calls valid, empty `thinking`, `done_reason` `stop`, no fallback (8.3 to 9.3 s each).
- Check 2, first start: every service up, `model-pull` exited 0, health `db ok`, `model ready`, `sandbox runc`, 13
  simplifications; `docker compose down` and `up -d` again: `model-pull` ran 1.8 s and downloaded nothing (its layer of
  2.6 GB cannot arrive in that time). In a real browser the header lists all 13 simplifications and their triggers in the
  page language, none in the other (since slice 7d the header counts them and `#/simplifications` lists them). No document is FAILED.
- Check 3, sandbox: only `lo`, uid 10001, `touch` fails on a read-only file system, `none true [ALL]
  [no-new-privileges:true]`, memory 2 GiB, pids 256, `reader_backend` internal, `curl` to 11434 exits 7.
- Fixtures: the generator reports every file `unchanged` and the hashes of the whole inbox are identical on a second
  run; 11 documents in the manifest and 11 expected files. The top level then held 19 files, not 12: the 7 files of the
  hostile set (check 8) were already in the folder.
- Check 4, folder run: 6 ACCEPTED fixtures, 3 NEEDS_REVIEW with `MISSING_REQUIRED_FIELD` (`invoice-3-scan.pdf` also
  carries `VALIDATION_FAILED`), the wrong-VAT invoice `VALIDATION_FAILED`, the untyped letter `UNKNOWN_DOC_TYPE`; the
  reasons are rendered in both languages. The evidence is the run of 03:28 UTC on an empty database (18 documents in
  109 s); it was not repeated on a second empty database, since a reset needs the owner's word.
- Check 5, re-read: a second read took in 0 files and found 18 duplicates; a renamed copy of `act-1.png` was a duplicate of
  document 1 and the count stayed 19 (the copy was removed from the inbox afterwards).
- Check 6, sensitivity class: the upload of `README.md` is `unverified`; the 11 fixtures are `synthetic`. With a class
  without `may_leave` the live app refused to start and named the class on every restart, and a one-off run on a copy
  of the config exited 1; the config was restored and the app is up.
- Check 7, safe reading: 7 of 7 tests pass (symlink, hard link, sparse 1 GB manifest and the others).
- Check 8, hostile sizes: the generator rewrote nothing; the two oversized files are REJECTED `TOO_LARGE`, the
  password-protected PDF `ENCRYPTED`, the truncated DOCX `CORRUPT`, the `.zip` `UNSUPPORTED_FORMAT`, the blank PDF
  NEEDS_REVIEW `EMPTY`, the noise PNG NEEDS_REVIEW `LOW_OCR_QUALITY`; every one after 1 attempt; all containers up.
- Check 9, GPU-free suite: with the model stopped, 325 tests, 320 pass, 5 skipped (the GPU contract test), 0 fail.
- Check 10, registry: run live under T071; the classify request of a new upload listed `receipt` once the example was
  in `schemas/`; the example was removed and the app restarted, after which the registry has three types again.
- Check 11, model outage: with the model stopped, health says `model missing` and the new upload (document 21) waited
  at CLASSIFY with 0 attempts; 9 s after the model started its first classify attempt began and the document ended
  ACCEPTED 18 s after the start, with attempt 1 on every step.
- Check 12: `ollama ps` shows 100% GPU and the context 16384 of the compose file; all 25 stored calls ended with
  `done_reason` `stop`, 0 other.
- Check 13: foreign Host 421, foreign Origin 403, the documents count unchanged at 21.
- Check 14, evaluation: all figures of the Measurement Contract printed, `not a tier decision`, one new report
  `results/eval-20261101-040255-d8b0f5e9760c.json`, exit 1 (required fields 92.6%, 7 false accepts; the figures equal
  row 1 of the journal, since the documents added by the checks have no expected files).
- Language check (FR-057): Ukrainian on a fresh profile; English after the switch and after a reload; Ukrainian again
  after clearing site data; the VAT reason of document 17 reads in the chosen language in the table and in the detail.

Left in the live database by the run: document 19 (the probe of check 10), 20 (`README.md` upload) and 21 (the probe
of check 11), all from the browser upload path; stored data is only added to.
