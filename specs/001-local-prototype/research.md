# Research: Local Prototype of the Document Reader

**Feature**: `001-local-prototype` | **Date**: 2026-10-31 | **Plan**: [plan.md](plan.md)

Every version and digest below was read from its registry or documentation page on 2026-10-31; a value that could
not be verified is marked "unverified" and gets a task to confirm it before use (constitution XI). Each decision
names what was chosen, why, and what else was considered.

## R1. npm packages, exact versions

Decision: pin these exact versions in `app/package.json` (no `^`, no `~`); `parser/package.json` has no runtime
dependency.

| Package | Version | Role | Notes |
| --- | --- | --- | --- |
| fastify | 5.12.7 | API server | brings `@fastify/ajv-compiler` ^4.0.5 (Ajv 8 for route schemas) |
| @fastify/multipart | 10.1.6 | streamed uploads | >= 10.1.1 as C8 requires; `limits.fileSize`, `limits.files: 1`, `limits.parts`; `saveRequestFiles()` is never called |
| @fastify/static | 10.1.8 | serves the built front | |
| @fastify/helmet | 13.2.0 | CSP and `nosniff` headers | |
| pg | 8.23.1 | PostgreSQL client | pool, `BEGIN`/`COMMIT`, `$1` parameters |
| ajv | 8.20.0 | JSON Schema 2020-12 validation | `Ajv2020`, `strict: true`, `allErrors: false` |
| ajv-formats | 3.0.1 | `format: date` | |
| react, react-dom | 19.3.1 | the front | |
| vite | 8.3.5 | front build | engines `^20.19.0 || >=22.12.0`; Node 24 fits |
| @vitejs/plugin-react | 6.1.2 | JSX | peer vite ^8 |
| typescript (dev) | 6.0.3 | `tsc --noEmit` | see rationale |
| @types/node (dev) | 24.19.2 | Node 24 typings | latest 24.x line read from the registry on 2026-10-31 |
| @types/pg (dev) | 8.23.1 | | |
| @types/react, @types/react-dom (dev) | 19.3.0 | | |

Rationale for TypeScript 6.0.3 and not 7.0.2: the `latest` tag is 7.0.2, the native compiler that ships platform
binaries as optional dependencies; 6.0.3 is the last release of the JavaScript compiler line, supports
`erasableSyntaxOnly` (since 5.8) and `verbatimModuleSyntax`, and adds no platform binary to the image. Alternatives:
7.0.2 (new binary supply chain in the image, not needed for `--noEmit`), 5.9.3 (older line, no advantage).

Sources: registry.npmjs.org/<pkg>/latest (2026-10-31); the `@fastify/multipart` README on GitHub.

## R2. Container images, tags and digests

Decision: three images from registries, pinned by tag and manifest-list digest in `compose.yaml` and the
Dockerfiles; two own images built from them.

| Image | Tag | Digest (manifest list) | Used for |
| --- | --- | --- | --- |
| node | 24.22.2-bookworm-slim | sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c | base of `app` and of `parser` (Node 24 for the parser's own code; Debian bookworm apt for the tools) |
| pgvector/pgvector | 0.8.7-pg17 | sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d | `db` (PostgreSQL 17; the extension stays uncreated) |
| ollama/ollama | 0.40.13 | sha256:b2f0122c476bc9fe7ce679d8bb4bd555351e25e2554eefb156f61cb0a89cf429 | `model` and `model-pull`; >= 0.31.2 as C4 requires |

Rationale: the parser is based on the same Node image as the app rather than `debian:bookworm-slim` because
Debian's own `nodejs` package is 18 and cannot run the parser's TypeScript; bookworm's apt repositories are
available in the Node image. Alternative considered: `debian:12.15-slim` plus a Node tarball (more moving parts).

Model: tag `qwen3.5:4b` (3.3-4.0 GB download, Q4_K_M weights plus the vision projector). The full sha256 digest is
not shown on the library page (only short ids `7f3251fa6878` for the manifest, `d8b0f5e9760c` for the weights), so
the pin is taken from `GET /api/tags` after the first pull and written into `config/model.json` as
`{ "tag": "qwen3.5:4b", "digest": "<sha256>" }`; readiness then compares against it (FR-037). Task for phase 1.

Sources: hub.docker.com/v2/repositories/... tag endpoints (2026-10-31); ollama.com/library/qwen3.5.

## R3. Libraries not added (constitution IX)

Decision: no ORM or query builder (plain `pg` with hand-written parameterised SQL in `app/src/db/`); no router
(three views are component state); no data library such as TanStack Query (one `poll(url, 2000)` helper on
`fetch`); no i18n library (two flat JSON dictionaries and a `t()` function, R9); no validation library besides ajv
(zod would duplicate the registry); no Fastify plugins beyond the three named; no logging library beyond
Fastify's built-in logger. Rationale: each would be a dependency with a single consumer or none, and the owner's
rule asks for agreement per dependency. Alternatives: Drizzle or Kysely for SQL (rejected: 5 tables, 20 queries);
React Router (rejected: the owner rarely uses routers); TanStack Query (rejected: one polling list and one detail
fetch).

## R4. Parser image: apt packages (Debian 12 bookworm)

Decision: `apt-get install --no-install-recommends` with these exact versions pinned in the Dockerfile
(`package=version`):

| Package | Version | Role |
| --- | --- | --- |
| libreoffice-writer-nogui | 4:7.4.7-1+deb12u14 | DOC, DOCX, RTF, HTML to PDF (also the fixtures) |
| libreoffice-calc-nogui | 4:7.4.7-1+deb12u14 | XLSX to PDF |
| poppler-utils | 22.12.0-2+deb12u3 | pdfinfo, pdftotext, pdftoppm, pdftocairo |
| tesseract-ocr | 5.3.0-2 | OCR |
| tesseract-ocr-ukr, tesseract-ocr-eng | 1:4.1.0-2 | language data |
| librsvg2-bin | 2.54.7+dfsg-1~deb12u1 | rsvg-convert for SVG |
| imagemagick | 8:6.9.11.60+dfsg-1.6+deb12u14 | rotate, blur, noise, resize (fixtures and image inputs) |
| img2pdf | 0.4.4-3 | scanned PDF fixtures |
| qpdf | 11.3.0-1+deb12u1 (read in the pinned image by T007, 2026-10-31) | strips dates and ids from generated PDFs for byte-stable fixtures (R8) |
| file | 1:5.44-3 | content-based format detection |
| fonts-dejavu-core, fonts-liberation | 2.37-6, 1:1.07.4-11 | Cyrillic fonts for rendering |

`--no-install-recommends` keeps Java out: the `-nogui` LibreOffice packages only recommend a JRE (constitution,
Security and Data Constraints). The parser's uid is 10001; HOME is on tmpfs because LibreOffice writes a profile.

Sources: packages.debian.org/bookworm/<pkg> (2026-10-31); qpdf's version to be read at build time (task).

## R5. Ollama request, readiness and server settings

Decision (C4, C5, C7):

- Server environment: `OLLAMA_CONTEXT_LENGTH=16384` (one server-wide context; the adapter sends no `num_ctx`),
  `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=30m`.
- Request: `POST /api/chat` with `model`, `messages`, `stream: false`, `think: false`, `format: <wire schema
  object>`, `keep_alive: "30m"`, `options: { num_predict }` (1536 extract, 64 classify). `think: false` is the
  documented way to request no thinking; the reply's `message.thinking` must then be empty (contract test).
- Reply fields stored: `done_reason`, `total_duration`, `load_duration`, `prompt_eval_count`,
  `prompt_eval_duration`, `eval_count`, `eval_duration` (all durations in nanoseconds).
- Readiness: `GET /api/tags` lists `models[].name` and `models[].digest` (full sha256); ready when the configured
  digest is present and one warm-up call returned `done_reason: "stop"`.
- `model-pull`: `ollama pull qwen3.5:4b` against the shared `models` volume; the Ollama CLI exits 0 and downloads
  nothing when the layers are present (acceptance check 2 verifies this on the real image).
- Fallbacks (C4): `/api/generate` with `format`, then `think: true` with `format`; every reply validated by ajv.

Alternatives: `num_ctx` per request (rejected by C7: one server-wide context), streaming (no consumer), the
OpenAI-compatible endpoint (no structured-output guarantee documented for it).

Sources: github.com/ollama/ollama docs/api.md; docs.ollama.com/faq and /capabilities/thinking (2026-10-31).

## R6. Node 24 type stripping, TypeScript flags, test runner

Decision: run `.ts` directly with Node 24.22.2; no build step for the backend and the parser.

- Type stripping is on by default (default since Node 23.6, no experimental warning since 24.3, stable since
  24.12). Rejected syntax: `enum`, `namespace` with runtime code, parameter properties, `import x =`, decorators.
  `tsconfig.json` is ignored at runtime; `.ts` extensions are mandatory in relative imports; `import type` for
  type-only imports; no `.tsx` under Node (the front's `.tsx` is compiled by Vite only; shared modules are `.ts`).
- `app/tsconfig.json` (backend): `module: nodenext`, `target: es2024`, `noEmit`, `strict`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions`, `types: ["node"]`. `app/web/tsconfig.json`: `jsx:
  react-jsx`, `moduleResolution: bundler`, same strictness, `erasableSyntaxOnly` off (enums allowed in the front,
  FR-057 context). A shared folder `app/src/shared/` is compiled by both and follows the backend rules.
- `node --test` discovers `**/*.test.ts` and `**/test/**/*.ts` by default when type stripping is on; the suite is
  `node --test` run from `app/` (acceptance check 9) and the contract test by path (check 1).
- Snapshots: own JSON files compared with `assert.deepStrictEqual`, regenerated with `UPDATE_SNAPSHOTS=1`
  (rejected: Node's snapshot API, still behind a flag in the 24 line per the docs read; a flag the suite would
  carry forever).

Sources: nodejs.org/docs/latest-v24.x/api/typescript.html and /api/test.html; TypeScript 5.8 release notes.

## R7. Fastify server shape

Decision:

- One Fastify instance, `logger: true` (pino, JSON), `trustProxy: false` (default), `bodyLimit` 64 KB for JSON
  routes; multipart limits from the thresholds file per request.
- Listens on `0.0.0.0:3000` inside the container; Compose publishes `127.0.0.1:3000:3000` so the host sees it on
  loopback only (C15). The `Host` check (R11) refuses anything but the loopback names.
- `onRequest` hook (the first hook, before parsing) implements the Host and Origin rule; `@fastify/helmet` sets
  `Content-Security-Policy: default-src 'self'; img-src 'self'; frame-ancestors 'none'` and
  `X-Content-Type-Options: nosniff`; `@fastify/static` serves `app/dist/web` at `/` with `wildcard: false` and an
  explicit `index.html` route.
- Route schemas use Fastify's Ajv 8 (`coerceTypes: 'array'`, `removeAdditional: true` defaults) for params and
  query; the response schemas of [contracts/api.md](contracts/api.md) are declared for serialisation.
- The parser's socket server is Node's `http.createServer().listen('/jobs/parser.sock')` (built-ins only; no
  Fastify inside the sandbox). The app's client is `http.request({ socketPath })`.

Alternatives: binding the app to `127.0.0.1` inside the container (rejected: the published port would not reach
it); a CORS plugin (rejected by C15: same-origin only).

Sources: fastify.dev Reference Server, Hooks, Validation-and-Serialization; nodejs.org/api/net.html.

## R8. Parser toolchain and fixture formats

Decision (C8, C9, C17), one command per step, each under its own timeout and memory limit:

- Detect: `file --mime-type -b <input>`; the allowed set maps to a route: `application/pdf` -> pdf; office types
  (`application/msword`, OOXML, RTF, XLSX) -> soffice -> pdf; `image/png`, `image/jpeg` -> image; `image/svg+xml`
  -> `rsvg-convert`; anything else -> `UNSUPPORTED_FORMAT`.
- Office to PDF: `soffice --headless --norestore --nologo -env:UserInstallation=file:///tmp/<job>/lo --convert-to
  pdf --outdir /tmp/<job> <input>`; one at a time; `convert_timeout_s` 120.
- PDF: `pdfinfo` first (page count against `page_cap` 50, page size, `Encrypted: yes` -> `ENCRYPTED`, parse
  failure -> `CORRUPT`); per page `pdftotext -layout -f n -l n`; a page with fewer than
  `scanned_page_max_chars` characters is a scanned page and goes to OCR; preview `pdftoppm -png -scale-to 1240 -f n
  -l n`; OCR input `pdftoppm -png -r 300 -f n -l n`.
- OCR: `tesseract <png> <base> -l ukr+eng --psm 3 txt tsv` in one pass; the `tsv` word table gives `conf` per word
  for the `LOW_OCR_QUALITY` rule.
- Images: dimensions read from the header before any decode (PNG IHDR, JPEG SOF) against `png_max_side_px` 4000;
  ImageMagick `convert -resize` for the preview; OCR on the original raster; SVG rendered by `rsvg-convert -f png -w
  1240` with the same caps.
- Fixtures generator: one HTML template per type filled from `companies.ts` (fictional names, valid EDRPOU and
  IBAN, R12) and a fixed data object; `soffice --convert-to pdf|docx|doc|rtf` (writer) and `xlsx` (calc from the
  HTML table); scanned variants: `pdftoppm -r 150` -> `convert -rotate 1.4 -blur 0x0.7 +noise Gaussian -seed 7
  -strip` -> `img2pdf --nodate` (scanned PDF) or saved as PNG / JPEG; SVG by `pdftocairo -svg`. Expected values are
  written from the same data object (FR-047).
- Determinism (C3): `SOURCE_DATE_EPOCH` fixed, ImageMagick `-seed`, metadata stripped; generated PDFs are passed
  through `qpdf --deterministic-id --remove-page-labels` with `/CreationDate` and `/ModDate` removed by the
  generator before hashing. Risk: LibreOffice PDF export may still differ between runs; the phase 3 build order
  (text PDF first, then one format per step) exists to find this early. If byte stability cannot be reached for a
  format, the manifest records the sha256 of the first run and the generator verifies instead of regenerating that
  file (task to decide in phase 3, recorded as a named simplification if taken).

Alternatives: Docling or Tika for parsing (rejected: round 1, Python or Java in the sandbox); PaddleOCR (rejected:
Ampere-only on vLLM, round 2); a single `convert` pipeline for everything (rejected: no per-step limits).

Sources: handoff C8, C9, C17; man pages of poppler-utils 22.12, tesseract 5.3, ImageMagick 6.9, img2pdf 0.4.

## R9. Interface languages

Decision (FR-057, FR-058): `app/web/src/i18n/uk.json` and `en.json` as flat key maps for the page's own texts;
`t(key)` reads the active dictionary; the active language is `localStorage["reader.lang"]` with `uk` as the
default; field labels and reason templates arrive from `GET /api/meta` in both languages, and the page picks the
active one at render time; `{param}` placeholders are substituted by a tiny formatter and the result is set as
text content. `test/i18n.test.ts` asserts equal key sets of the two dictionaries and both languages on every
registry label and reasons template. Alternatives: i18next (rejected: 2 languages, ~40 keys), server-side
language (rejected: the API has no user state).

## R10. Testing strategy

Decision: `node:test` and `node:assert/strict` for everything in `app/` and `parser/`; the replay adapter plus
golden parser outputs (recorded manifests, page texts and PNG headers of the eleven fixtures) make the pipeline
tests GPU-free (acceptance check 9); `test/status.test.ts` is a table over all 15 codes and both attempt branches;
`test/wire-schema.test.ts` compares the derived wire schemas with JSON snapshots; `test/safe-read.test.ts` plants a
symlink, a hard link and a 1 GB sparse manifest in a temporary jobs folder; `test/checks.test.ts` covers VAT,
dates, EDRPOU, IBAN and the normalisation table; `test/pipeline-replay.test.ts` drives the eleven fixtures through
the worker against a real PostgreSQL (the `db` service, not a fake: the owner's rule) and also feeds three invalid
JSON replies to reach FAILED. Front: no unit test framework in the prototype; the page's pure logic lives in
`app/src/shared/` and is tested under `node:test`; the browser behaviour is covered by acceptance checks 4, 6, 13
and the FR-057 check in quickstart.md. Alternatives: Vitest and Testing Library (deferred until a component has
logic worth it), Playwright (phase 8 of the learning plan, not this feature).

## R11. Host and Origin rule

Decision (C15, acceptance check 13): in `onRequest`, `Host` must be `127.0.0.1:3000` or `localhost:3000` (the
configured port), else `421 Misdirected Request`; for `POST`, `Origin` must equal `http://` plus one of those hosts
and the header `X-Reader-Request: 1` must be present, else `403`; a `GET` with a foreign `Origin` is `403`. No
`Access-Control-*` header is ever set. Rationale: a page on another origin cannot read responses without CORS and
cannot send the custom header without a preflight that is refused; the `Host` check defeats DNS rebinding on
loopback. Alternatives: a CSRF token (more state for one user), `Sec-Fetch-Site` only (not sent by every client).

## R12. Checksums for fixtures and checks

Decision: implement both in `app/src/shared/checksums.ts` (used by the checks and by the fixtures generator).

- EDRPOU (8 digits): weights `[1,2,3,4,5,6,7]` for the first seven digits; when the code is between 30000000 and
  59999999 the weights are `[7,1,2,3,4,5,6]`; `check = sum mod 11`; if `check == 10`, repeat with every weight
  plus 2 and take `(sum mod 11) mod 10`; the result is the eighth digit. Source: python-stdnum `ua/edrpou.py`
  (an official Derzhstat text was not found; the boundaries follow the stdnum implementation, marked unverified
  against an official source).
- Ukrainian IBAN: 29 characters, `UA` + 2 check digits + 6-digit bank code + 19-character account; mod 97-10:
  move the first four characters to the end, map letters to numbers (A=10 ... Z=35), the integer modulo 97 must be
  1; generation sets the check digits to `98 - (n mod 97)`, zero-padded. Source: Wikipedia IBAN, iban.com
  structure page.

The fixtures generator produces valid codes; `checks.test.ts` has both valid and invalid cases.

## R13. Normalisation and value parsing (C11), pinned

Decision: as written in [contracts/type-schema.md](contracts/type-schema.md), section Normalisation: NFC;
apostrophe variants to `'`; non-breaking and thin spaces to a space; whitespace runs to one space; soft hyphens
removed; hyphen plus line break joins the word. Offsets are mapped back to the stored text through an index map.
Dates: `DD.MM.YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, Ukrainian month names in the genitive (`01 березня 2026 р.`).
Money: thousands separated by spaces or non-breaking spaces, comma or dot decimal mark, `грн`, `UAH`, `₴` all
mean UAH; stored as integer kopiyky. Enumerations: exact match after normalisation. Alternatives: fuzzy matching
of fragments (rejected: a near match is not evidence, constitution VI).

## R14. Thresholds, starting values (C13; every value provisional, source "handoff 2026-10-17" or "estimate")

| Key | Value | Unit | Note |
| --- | --- | --- | --- |
| model.num_ctx | 16384 | tokens | server-wide `OLLAMA_CONTEXT_LENGTH` |
| model.num_predict_extract / _classify | 1536 / 64 | tokens | |
| model.client_timeout_s | 180 | s | |
| model.keep_alive | 30m | | |
| model.chars_per_token | 3 | chars | calibrated by the eval |
| model.cold_load_ns | 2000000000 | ns | load above this marks the call cold |
| parser.convert_timeout_s | 120 | s per document | |
| parser.render_timeout_s_per_page / ocr_timeout_s_per_page | 10 / 30 | s | |
| parser.page_cap | 50 | pages | |
| parser.ocr_dpi | 300 | dpi | |
| parser.render_width_px | 1240 | px | |
| parser.manifest_max_bytes / png_max_bytes / text_max_bytes | 65536 / 8388608 / 1048576 | bytes | |
| parser.png_max_side_px | 4000 | px | |
| parser.tool_memory_mb | 1024 | MB | container limit 2048 |
| intake.upload_max_bytes | 52428800 | bytes | 50 MB |
| quality.ocr_low_confidence | 60 | tesseract conf | a word under it is "low" |
| quality.ocr_low_share | 0.4 | share | a page with more low words than this is low quality |
| quality.scanned_page_max_chars | 50 | chars | text layer under it -> OCR |
| quality.empty_min_chars | 20 | chars | page under it is blank; EMPTY when more than half the pages are blank |
| run.bound_minutes | 15 | min | warm run of the 11 fixtures |
| ui.preview_width_px / ui.poll_interval_ms | 1240 / 2000 | | |
| eval.pass_required_match | 1.0 | share | owner decision 2026-10-31 |
| eval.max_false_accepts | 0 | count | owner decision 2026-10-31 |
| eval.ceiling_tokens_per_document | 6000 | tokens | owner decision 2026-10-31 |
| eval.ceiling_seconds_per_page_warm | 60 | s | owner decision 2026-10-31 |

`LOW_OCR_QUALITY` fires when more than half of the OCR pages of a document are low quality (round 1 example: 3 of
5 pages); the lease of a step is the sum of its timeouts (parse: convert + pages x (render + OCR); classify and
extract: client timeout; check: 30 s).

## Open items carried into tasks

- Read the full sha256 of `qwen3.5:4b` from `/api/tags` after the first pull and pin it (R2).
- ~~Read qpdf's bookworm version~~ done by T007: 11.3.0-1+deb12u1, pinned in `parser/Dockerfile` and recorded in R4.
- Verify byte-stable PDF output of LibreOffice under `SOURCE_DATE_EPOCH` plus qpdf on the first fixture (R8).
- Confirm the EDRPOU weight boundaries against an official source if one is found; the fixtures only need
  self-consistency (R12).
