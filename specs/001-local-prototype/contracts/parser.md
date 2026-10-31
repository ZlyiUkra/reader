# Contract: app to parser

The parser is a long-lived container with no network (C9). It serves one endpoint over a Unix socket in the shared
jobs volume and runs every job as a fresh child process (C8). The app is the only client.

## Transport

- Socket: `/jobs/parser.sock`, HTTP/1.1 over the Unix socket. The parser unlinks a stale socket at start.
- One request at a time: a second `POST /parse` while one is in flight is answered `429` and retried by the app
  after its own backoff. One LibreOffice conversion runs at a time (C9).

## POST /parse

Request: `{ "jobId": string }` where `jobId` matches `^[a-z0-9]{32}$` (a random id minted by the app; never the
sha256, never a name).

Input: the app has placed the original at `/jobs/in/<jobId>/input` (read-only mount) before the call. Nothing else
is read from `in`.

Output: the parser writes to `/jobs/out/<jobId>/` only these names, and `manifest.json` last:

| File | Content |
| --- | --- |
| `page-<n>.png` | rendered page `n` (1-based), PNG, rendered with `-scale-to <thresholds.render.width_px>` |
| `page-<n>.txt` | page text from the text layer, or the OCR text; UTF-8 |
| `page-<n>.tsv` | OCR word table (Tesseract `tsv`) when OCR ran; absent for text-layer pages |
| `manifest.json` | the manifest below |

Response: `200 { "jobId": string, "ok": true }` once the manifest is written, or `200 { "jobId": string, "ok": false,
"code": "TOO_LARGE" | "CORRUPT" | "ENCRYPTED" | "UNSUPPORTED_FORMAT" | "INTERNAL_ERROR", "params": object }` when the
job ended with a reason (C6). A dead child or a parser crash is seen by the app as a connection error and mapped to
`INTERNAL_ERROR`.

## Manifest

Validated by the app against `parser-manifest.schema.json` with `additionalProperties: false` before any other
output file is opened (C8). The app reads only the files the manifest names, by their fixed pattern, never a path
from the manifest.

```json
{ "version": 1, "jobId": "…", "detectedMime": "application/pdf", "converter": "soffice 7.4.7" | null,
  "pageCount": 3,
  "pages": [ { "n": 1, "source": "text_layer" | "ocr", "engine": "pdftotext", "engineVersion": "22.12.0",
               "dpi": null, "widthPx": 1240, "heightPx": 1754, "ocrWordsTotal": null, "ocrWordsLow": null,
               "timingsMs": { "render": 120, "text": 15, "ocr": 0 } } ],
  "timingsMs": { "detect": 3, "convert": 0, "pdfinfo": 8, "total": 400 },
  "limitsHit": [] }
```

## Reading the output safely (app side, FR-014)

1. Empty `/jobs/out/<jobId>/` before dispatch; create it with the fixed mode.
2. After the response: `lstat` the manifest; it must be a regular file with `nlink == 1` and size under
   `thresholds.parser.manifest_max_bytes`; open with `O_NOFOLLOW`; parse and validate.
3. For each page `n` in `1..pageCount`: `lstat` + `O_NOFOLLOW` on `page-<n>.png`, size under
   `thresholds.parser.png_max_bytes`, PNG signature and IHDR dimensions under the caps before the file is stored
   under `pages/<sha256>/page-<n>.png`; `page-<n>.txt` under `thresholds.parser.text_max_bytes`.
4. Any violation fails the job with no file read further and no file served; the document gets `INTERNAL_ERROR`
   with `cause: "unsafe_output"` (acceptance check 7).

## Child process rules (parser side, C8, C9)

- Each job: own temporary directory under tmpfs, own `-env:UserInstallation=file:///tmp/<jobId>/lo` profile,
  `detached` child in its own process group; on timeout the whole group is killed; leftover processes of the
  parser's uid are killed after the job and the parser exits if any survive.
- Per-tool timeouts and memory limits from the thresholds file (convert, render per page, OCR per page), each below
  the container's limits. A tool over its limit ends the job with `TOO_LARGE` and the limit in `params`.
- Checks before rendering: `pdfinfo` page count under `thresholds.parser.page_cap`, page size under the cap; image
  dimensions under the cap before any decode.
- Format detection by content (`file --mime-type`), never by name (FR-010).
