# Data Model: Local Prototype of the Document Reader

**Feature**: `001-local-prototype` | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

Two kinds of data exist. The database holds the pipeline state and everything the pipeline produced (constitution
III: the status table is the single source of truth, stored data is append-only). Configuration files hold the
closed lists the pipeline reads at start: the schema registry, the reasons file, the sensitivity classes, the
thresholds and the interface dictionaries (constitution II: derived, never maintained in parallel).

## Database (PostgreSQL 17)

Conventions: `bigint` identity primary keys; `timestamptz` for every time; money as `bigint` kopiyky; JSON as
`jsonb`; no foreign key is ever `ON DELETE CASCADE` (nothing is deleted); the application role owns no schema and
is not a superuser; every query is parameterised and every identifier comes from code or the registry.

### schema_version

One row. The application reads it at start and refuses to run unless `version` equals the value compiled into the
application (FR-034). A schema change means `docker compose down -v`.

| Column | Type | Notes |
| --- | --- | --- |
| version | integer PK | starts at 1 |
| applied_at | timestamptz | when the initial SQL ran |

### documents

The status table. One row per distinct content hash. Its rows change after insert, and only in the columns marked
mutable; the only other table with updatable columns is `step_runs`. A column marked "mutable, once" goes from null to
its value in one step and never changes after.

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | the visible number shown to the owner (clarification 5) |
| sha256 | char(64) unique not null | identity (FR-002); lowercase hex |
| original_name | text | description only, from the upload or the inbox listing |
| original_path | text | description only; relative to the inbox for folder documents, null for uploads |
| size_bytes | bigint not null | |
| detected_mime | text | mutable, once; set by the parser from content, null until parsed |
| class | text not null | `synthetic` or `unverified`; the closed list lives in the classes file, the app validates |
| doc_type | text | mutable, once; registry type name after classification; null before and for "none" |
| schema_id | text | mutable, once; `$id` of the type schema version used; null until classified |
| status | text not null | mutable; see State machine |
| attempts | integer not null default 0 | mutable; the attempt number of the step the document is in: incremented on each claim, set back to 0 when the step ends and the document moves on to the next one; a terminal status keeps the count of its last step |
| checks_done | boolean not null default false | mutable; true once the checks step ran |
| locked_until | timestamptz | mutable; the lease; null when unclaimed |
| locked_by | text | mutable; worker instance id |
| accepted_extraction_id | bigint | mutable; the extraction whose fields were accepted; null otherwise |
| parent_id | bigint references documents | reserved for container documents; always null in the prototype |
| blob_key | text not null | relative key of the stored original, `blobs/<sha256[0:2]>/<sha256>` |
| created_at | timestamptz not null | intake time |
| updated_at | timestamptz not null | mutable |

Indexes: unique on `sha256`; `(status, locked_until)` for the claim query.

### step_runs

One row per attempt of one step on one document. The claim inserts it with `started_at`; the worker completes it once,
when the attempt ends, by setting `finished_at`, `outcome` and `details` on the row where `finished_at` is null. Those
three columns are the only ones the application role may update, and nothing else in the row ever changes. This is a
named simplification (spec.md, Deferred Simplifications) that departs from append-only (constitution III): a timing
row cannot be written complete before the step has run. What undoes it: at the first non-synthetic document, one insert
at the end of the attempt, in the step's own transaction, and the update grant dropped.
Source of the per-step durations in the detail view and of the parse and model time split in the evaluation (C14).

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| document_id | bigint not null references documents | |
| step | text not null | `parse`, `classify`, `extract`, `check` |
| attempt | integer not null | the value of `documents.attempts` at claim time |
| started_at | timestamptz not null | |
| finished_at | timestamptz | null while in flight, and for an attempt cut short by a restart (the boot requeue does not complete it) |
| outcome | text | `ok`, `reason`, `internal_error`, `lease_expired` |
| details | jsonb | tool timings, model warm or cold flag, byte counts |

### pages

One row per rendered page of a document; append-only.

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| document_id | bigint not null references documents | |
| page_no | integer not null | 1-based |
| width_px | integer not null | of the stored preview |
| height_px | integer not null | |
| png_blob_key | text not null | relative key, `pages/<sha256>/page-<n>.png` |
| created_at | timestamptz not null | |

Unique on `(document_id, page_no)`.

### page_texts

One reading of one page (constitution V: each page is read once per engine); append-only.

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| page_id | bigint not null references pages | |
| source | text not null | `text_layer` or `ocr` |
| engine | text not null | `pdftotext`, `tesseract`, `xlsx`, ... as the parser names it |
| engine_version | text not null | |
| dpi | integer | null for text layers |
| text | text not null | the stored page text the fragment search runs on |
| ocr_words_total | integer | from the OCR word table; null for text layers |
| ocr_words_low | integer | words under the confidence cut-off of the thresholds file |
| timings | jsonb not null | per parser step, milliseconds |
| thresholds | jsonb not null | the thresholds in force when this reading was made (C13) |
| created_at | timestamptz not null | |

### extractions

One model call on one document, classification or extraction; append-only (C12).

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| document_id | bigint not null references documents | |
| kind | text not null | `classify` or `extract` |
| attempt | integer not null | |
| adapter | text not null | `ollama` or `replay` |
| model_name | text not null | the configured tag |
| model_digest | text not null | from the model server's tag listing |
| schema_id | text | type schema `$id` for extract; null for classify |
| registry_hash | text not null | hash of the registry contents the prompt was built from |
| prompt_hash | text not null | |
| wire_schema_hash | text not null | |
| raw_request | jsonb not null | exactly what was sent |
| raw_response | jsonb not null | exactly what came back |
| done_reason | text | `stop`, `length`, or the server's value |
| load_duration_ns | bigint | |
| prompt_eval_count | integer | |
| prompt_eval_duration_ns | bigint | |
| eval_count | integer | |
| eval_duration_ns | bigint | |
| total_duration_ns | bigint | |
| cold | boolean not null | true when the server reported a model load for this call, or this is the first call after a warm-up that had to load the model |
| thresholds | jsonb not null | the thresholds in force (C13) |
| created_at | timestamptz not null | |

### fields

One extracted field of one extraction; append-only (C12). The typed value is `normalize(kind, verbatim)` computed by
the pipeline; the model's own value stays only in `extractions.raw_response`.

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| extraction_id | bigint not null references extractions | |
| document_id | bigint not null references documents | denormalised for the detail view |
| name | text not null | field name from the registry |
| kind | text not null | `date`, `money`, `enum`, `string`, `edrpou`, `iban` |
| value | jsonb | typed value: ISO date string, `{amount, currency}` with integer kopiyky, enum member, string; null when not found |
| verbatim | text | the fragment the model quoted; null when the model reported the field absent |
| page_text_id | bigint references page_texts | the reading where the fragment was found; null when not found |
| offset_start | integer | character offset in `page_texts.text` after normalisation mapping |
| offset_end | integer | |
| found | boolean generated always as (offset_start is not null) stored | |
| source | text not null | `model` in the prototype |
| bbox | jsonb | always null in the prototype (deferred) |
| created_at | timestamptz not null | |

### reasons

Reason codes attached to a document; append-only. Messages are never stored: they are rendered from the reasons
file template in the interface language at display time (C1, FR-025).

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK | |
| document_id | bigint not null references documents | |
| code | text not null | one of the 15 codes of the reasons file |
| params | jsonb not null | the named parameters of the template |
| step | text not null | emitting step, or `intake` |
| attempt | integer not null | the attempt that emitted it |
| created_at | timestamptz not null | |

`DUPLICATE` is never stored: it is reported in the intake response only (FR-003).

### Blobs

Files on a volume, addressed by keys relative to a configured root (FR-033): originals under `blobs/`, page previews
under `pages/`, parser job folders under `jobs/in/<jobId>/` and `jobs/out/<jobId>/`. Keys are never host paths and
never contain user-supplied names.

## State machine

`documents.status` holds either a terminal state or the name of the step the document waits for or is in.

```text
RECEIVED --claim--> PARSE --ok--> CLASSIFY --type--> EXTRACT --ok--> CHECK --no reasons--> ACCEPTED
                      |              |  "none"                            |  review reasons
                      |              +---------------------------------> NEEDS_REVIEW <----+
                      |  LOW_OCR_QUALITY / EMPTY ---------------------------^
                      +--ENCRYPTED / CORRUPT / TOO_LARGE / UNSUPPORTED_FORMAT--> REJECTED
any step --INTERNAL_ERROR, attempts < 3--> same step (requeued)
any step --INTERNAL_ERROR, attempts >= 3--> FAILED
```

- A claim sets `locked_until = now() + lease(step)` where `lease(step)` is the sum of that step's timeouts from the
  thresholds file, and `attempts = attempts + 1`, inside `SELECT ... FOR UPDATE SKIP LOCKED` (FR-031), and inserts the
  attempt's `step_runs` row with `started_at` in the same transaction.
- A step's outputs (pages, page_texts, extractions, fields, reasons), the completion of its `step_runs` row and the new
  status commit in one transaction; the model call runs between two transactions, never inside one (FR-023, FR-030).
- An expired lease found by the worker completes the dead attempt's `step_runs` row (`finished_at` is the moment of
  recovery, `outcome` is `lease_expired`) and records a reason `INTERNAL_ERROR {cause: "lease_expired"}`; the next claim
  counts as a new attempt (FR-031).
- On start the single worker requeues rows it left in flight: `locked_until` is cleared for rows locked by its own
  instance id (named simplification).
- `status(reasons, attempts, checksDone)` is the one function of FR-026. `INTERNAL_ERROR` reasons count only when
  their `attempt` equals the document's current `attempts` and the step being settled emitted them (attempts are
  counted per step, so an earlier step's error with the same number is not this step's); every other code counts
  whatever its attempt. First matching rule wins: rejection codes give REJECTED; `INTERNAL_ERROR` with attempts >= 3
  gives FAILED; `INTERNAL_ERROR` with attempts < 3 gives the current step; review codes give NEEDS_REVIEW; no reasons
  and `checksDone` gives ACCEPTED; otherwise the current step. A table test covers all 15 codes (acceptance check 9).
- Review codes emitted at parse (`LOW_OCR_QUALITY`, `EMPTY`) end the document in NEEDS_REVIEW without classification;
  `UNKNOWN_DOC_TYPE` ends it after classification without extraction (FR-016).

## Configuration data (files read at start)

### Schema registry: `schemas/<type>.v<n>.json`

One JSON Schema (draft 2020-12) per type version, `$id` = `https://reader.local/schemas/<type>.v<n>.json`. Standard
keywords carry the business rule (`required`, `type`, `enum`); vendor keys under `x-reader` carry what the pipeline
derives from: per field `kind`, labels `{uk, en}`, and per type the `checks` (VAT rule with the money field names
and the rate, date order pairs, checksum fields) and labels `{uk, en}`.
Contract: [contracts/type-schema.md](contracts/type-schema.md).

Initial registry (FR-045, Key Entities of the spec): `invoice.v1.json`, `act.v1.json`, `contract.v1.json`.

### Reasons file: `config/reasons.json`

All 15 codes with `outcome`, `templates: {uk, en}`, `params` (names and kinds), `trigger`, `emitted_by`, `emitted`
(boolean; 11 true, 4 false). Contract: [contracts/reasons.schema.json](contracts/reasons.schema.json).

### Sensitivity classes: `config/classes.json`

Closed list `[{name, may_leave, description}]`; the prototype ships `synthetic` (may_leave false) and `unverified`
(may_leave false). A class without `may_leave` fails validation and the app exits naming the class (FR-007). The
intake rule is code: `synthetic` only when the sha256 is in the generator manifest, else `unverified` (FR-006).

### Thresholds: `config/thresholds.json`

Every tunable value with `value`, `unit`, `status: "provisional"` and `source` (C13). Snapshotted into
`page_texts.thresholds` and `extractions.thresholds`.
Contract: [contracts/thresholds.schema.json](contracts/thresholds.schema.json).

### Interface dictionaries: `web/src/i18n/uk.json`, `web/src/i18n/en.json`

Flat key to string maps for the page's own texts; field labels and reason templates come from the API, which
reads them from the registry and the reasons file (FR-058). A test asserts both dictionaries have the same key set.

### Fixtures: `inbox/manifest.json`, `inbox/expected/<sha256>.json`

The generator writes the manifest (`[{file, sha256, type, format, expected}]`) at the top level of the inbox and one
expected file per fixture (the schema instance, expected status and codes), keyed by sha256, into the `expected/`
subfolder of the inbox (FR-044, FR-047). In a manifest row `type` is `invoice`, `act`, `contract` or `none` (the
document of no registered type), `format` is one of `pdf`, `pdf-scan`, `docx`, `doc`, `rtf`, `xlsx`, `png`, `jpg`,
`svg`, and `expected` is the relative path `expected/<sha256>.json`. An expected file holds `file`, `sha256`, `type`,
`format`, `instance`, `status` and `codes`: `instance` is the schema instance as printed on the document (dates in
ISO form, money as integer kopiyky, a required field the document lacks is absent) and `null` for `none`; `status` is
`ACCEPTED` or `NEEDS_REVIEW`; `codes` are the reason codes expected. Both live in the inbox because the `fixtures`
container is one-off and the `app` container mounts the inbox read-only: the evaluation reads `inbox/expected/*.json`
there. "Read folder" skips the manifest and every subfolder (clarification 1, FR-005). The hostile set (the
`hostile-*` files of T035) is written on demand next to the fixtures and is never listed in the manifest.

### Evaluation reports: `results/eval-<YYYYMMDD-HHMMSS>-<model digest prefix>.json`

One file per run (FR-048a).
Contract: [contracts/eval-report.schema.json](contracts/eval-report.schema.json).
