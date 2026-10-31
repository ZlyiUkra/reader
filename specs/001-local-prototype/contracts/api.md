# Contract: HTTP API of the app

The app serves the browser page and this JSON API on one port bound to `127.0.0.1` (C15). Every path below is
relative to `/api`. All responses are `application/json; charset=utf-8` except page images. Times are ISO 8601 UTC.

## Request rules (every endpoint)

- `Host` must equal the configured host (`127.0.0.1:<port>` or `localhost:<port>`); otherwise `421`.
- State-changing requests (`POST`) must carry `Origin` equal to the page's own origin and the header
  `X-Reader-Request: 1`; otherwise `403`. `GET` requests from a foreign `Origin` are refused with `403` too.
- No CORS headers are ever sent. Responses carry `Content-Security-Policy: default-src 'self'` and
  `X-Content-Type-Options: nosniff`.
- Errors use one shape: `{ "error": { "code": string, "message": string } }`. `message` is English and technical;
  it is not shown to the owner as is.

## GET /health

```json
{ "db": "ok" | "down",
  "model": "missing" | "ready",
  "modelDigest": string | null,
  "sandbox": "runc",
  "schemaVersion": number,
  "todo": [ { "id": string, "uk": string, "en": string, "trigger": { "uk": string, "en": string } } ] }
```

`todo` is the list of named simplifications (FR-052); it is never empty in the prototype. `model: "ready"` means the
pinned digest is present in the model server's tag list and a warm-up call passed (FR-037).

## GET /inbox

Top-level regular files of the inbox, without hashes (FR-005, clarification 1). Dot-files, subfolders, the manifest
and the expected-value files are not listed.

```json
{ "path": string, "files": [ { "name": string, "sizeBytes": number, "modifiedAt": string } ] }
```

## POST /inbox/read

Hashes every listed file and takes each one in (FR-001, FR-003). Body: none.

```json
{ "taken": [ { "number": number, "name": string, "sha256": string, "class": "synthetic" | "unverified" } ],
  "duplicates": [ { "name": string, "sha256": string, "originalNumber": number, "code": "DUPLICATE" } ],
  "skipped": [ { "name": string, "reason": "not_regular" | "too_large" | "unreadable" } ] }
```

## POST /documents

Multipart upload of one file (field `file`), streamed to disk under its sha256 with the limits of the thresholds
file (FR-004). Over the size limit: `413` with code `too_large`.

- New document: `201` with `{ "number": number, "sha256": string, "class": "unverified", "status": "RECEIVED" }`.
- Known hash: `200` with `{ "code": "DUPLICATE", "originalNumber": number, "sha256": string }` and no new row.

## GET /documents

The documents table (FR-053, FR-054). Never contains page texts, fragments or raw model data. Sorted by `number`
descending. Query `?limit=` (default 200, max 1000).

```json
{ "documents": [ {
    "number": number, "sha256": string, "originalName": string | null, "class": string,
    "type": string | null, "status": string, "attempts": number, "createdAt": string, "updatedAt": string,
    "reasons": [ { "code": string, "params": object } ] } ],
  "count": number }
```

Reason messages are not in the list: the page renders them from the templates it fetched once from `/meta`.

## GET /documents/{number}

The detail view (FR-053, FR-055): fields with evidence, pages, step durations, model identity. No raw model data.

```json
{ "number": number, "sha256": string, "originalName": string | null, "class": string, "type": string | null,
  "schemaId": string | null, "status": string, "attempts": number, "createdAt": string,
  "reasons": [ { "code": string, "params": object, "step": string, "attempt": number } ],
  "fields": [ { "name": string, "kind": string, "value": any, "verbatim": string | null,
                "page": number | null, "offsetStart": number | null, "offsetEnd": number | null, "found": boolean } ],
  "pages": [ { "page": number, "width": number, "height": number, "source": "text_layer" | "ocr" | null } ],
  "steps": [ { "step": string, "attempt": number, "startedAt": string, "finishedAt": string | null,
               "outcome": string | null, "durationMs": number | null } ],
  "model": { "name": string, "digest": string, "promptHash": string, "schemaId": string | null,
             "promptEvalCount": number | null, "evalCount": number | null, "cold": boolean } | null }
```

`fields` are those of `acceptedExtractionId`, or of the latest extraction when none was accepted. `404` for an
unknown number.

## GET /documents/{number}/raw

Clarification 3 (FR-053a): the raw model requests and responses of this one document, as stored. Served only per
document, never in the list.

```json
{ "number": number, "extractions": [ { "id": number, "kind": "classify" | "extract", "attempt": number,
    "adapter": string, "modelDigest": string, "doneReason": string | null,
    "rawRequest": object, "rawResponse": object, "createdAt": string } ] }
```

## GET /documents/{number}/pages/{page}.png

The page preview as `image/png` with `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=3600`
(C15). Width is capped by the thresholds file (about 1,240 px). Originals are never served; there is no endpoint
for them.

## GET /meta

Everything the page derives from the registry and the reasons file (FR-041, FR-058), fetched once at page load:

```json
{ "languages": ["uk", "en"], "defaultLanguage": "uk",
  "types": [ { "name": string, "schemaId": string, "labels": { "uk": string, "en": string },
               "fields": [ { "name": string, "kind": string, "required": boolean,
                             "labels": { "uk": string, "en": string } } ] } ],
  "reasons": [ { "code": string, "outcome": string, "emitted": boolean,
                 "templates": { "uk": string, "en": string }, "params": [ string ] } ],
  "statuses": [ string ] }
```

Templates use `{param}` placeholders; the page substitutes `params` and renders the result as text.

## Page behaviour bound to this API

- The documents table polls `GET /documents` every 2 seconds (FR-053).
- The language switch (uk default) is remembered in the browser only (FR-057); the API has no language state.
- Page images load lazily and only in the detail view.
