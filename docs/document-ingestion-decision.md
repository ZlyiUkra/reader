# Document ingestion pipeline: decision record

Status: proposed, not yet implemented
Date: 2026-10-17 (prices and benchmarks below are as of this date)
Origin: output of a five-archetype review board (critic, security, performance, architect, pragmatist), cross-examined by a separate interrogator before consensus.

## Goal

A file of any format comes in. The system recognizes it, fills fields according to the schema of the document type, and stores the fields together with the full content. If something is wrong with the document, it is handed to a human with a reason code and one or two sentences of explanation.

Requirements:

- any file extension
- about 16 fields per document type, plus the full content
- human-in-the-loop (HITL) review, always with a stated reason
- local models (no mandatory cloud calls)
- Docker deployment
- server and implementation language are not chosen yet

## Shared skeleton

All three options below follow the same steps and differ only in tooling.

1. **Intake**: mail, folder, or API. The original is stored unchanged under its sha256.
2. **Type and sandbox**: type detected by content, not by extension or name. Parsing happens in a sandbox with no network. An archive (ZIP) or message (EML) is unpacked into a tree of child documents, and each child goes through the pipeline separately.
3. **Parse**: documents with a digital text layer (PDF with text, DOCX, XLSX, mail) are read directly. Only scans and photos go to OCR or vision models. This is the main driver of time and cost. The route is chosen per page, not per document.
4. **Field extraction**: the schema of the document type is turned into a request to the model; output is JSON validated against the schema.
5. **Checks**: deterministic rules plus source verification (see decisions below).
6. **Outcome**, one of three:
   - all checks pass: written to the database (fields, content, source)
   - doubt: goes to a human with reason codes; after correction the human's decision is written to the database
   - file cannot or must not be opened: quarantine or rejection with a reason

### Handoff reasons

The list is closed. Every code has a description template with numbers filled in (not free text from the model). A document can have several reasons at once.

| Code | Outcome | Example description |
| --- | --- | --- |
| `ENCRYPTED` | reject | The file is password-protected. Resend it without a password. |
| `CORRUPT` | reject | The PDF is damaged: the file ends at page 3 of 7. |
| `MALWARE` | quarantine | Antivirus found a macro downloader in the DOCX. The file is isolated. |
| `TOO_LARGE` | reject | 412 pages against a limit of 200. Split the document. |
| `UNSUPPORTED_FORMAT` | reject | AutoCAD drawing (.dwg) is not supported. Export to PDF. |
| `DUPLICATE` | link to existing | The same file was already accepted on 2026-10-12 as no. 4812. No new record created. |
| `LOW_OCR_QUALITY` | human | Scan is unreadable: OCR confidence is below 0.6 on 3 of 5 pages. |
| `UNKNOWN_DOC_TYPE` | human | Type not determined. Closest is "invoice" (0.41) against a threshold of 0.7. |
| `MISSING_REQUIRED_FIELD` | human | Required field "Contract date" not found. |
| `VALIDATION_FAILED` | human | Company code "1234567" has 7 digits, 8 required. Total with VAT does not equal total without VAT plus VAT. |
| `LOW_CONFIDENCE` | human | Field "Invoice number": two attempts gave different values, "A-118" and "A-1I8". |
| `EMPTY` | human | Pages 2-4 of 4 are blank. The scanner may have fed empty sheets. |
| `INTERNAL_ERROR` | retry | The model server did not respond three times in a row. The document waits for a retry and goes to a human only after retries are exhausted. |
| `EXTRACTORS_DISAGREE` | human | Variant C only. Text and vision extraction disagree on two fields: "Amount" and "Date". |

## Options

### A. Off-the-shelf product: Paperless-ngx + paperless-gpt + Ollama

One product does everything from intake to tagging: mail and consume folder, Tika and Gotenberg, OCR (Tesseract or vision LLM), custom fields filled by paperless-gpt through a local model. The human works from a queue defined by a tag; a hook sets the tag and the reason.

Missing out of the box: per-field confidence, verification against the source, a separate schema per document type (custom fields are flat).

Verdict: **good as a pilot, not as the end state.** It is the shortest way to 20-30 real, human-verified documents, which is the reference set no option can be judged without. Blockers for the end state: data lives in two databases (Paperless and the target one), and there is no field confidence.

- Security: accept mail only from allowed senders; run Tika and Gotenberg under gVisor with no network; export to the target database only after a hook with deterministic rules.
- Pragmatist: the hook only sets the tag and the reason. As soon as gate logic starts moving into it, switch to C.

### B. No-code builder: n8n + Tika + docling-serve + Ollama/vLLM + Postgres

n8n (queue mode, Redis + Postgres) drives the flow; each step is an HTTP call to a service in its own container. The human gets a link to a form with the reason and fields; the flow waits on a Wait node until the form is submitted. Validation rules live in a separate service, not in Code nodes, so they can be tested.

Verdict: **makes sense under two conditions**: flows will be edited by people other than developers, and the product will not be sold as a service to third parties (n8n Sustainable Use License allows internal use, not reselling as a service). Three of five reviewers block until these two questions are answered.

- Security: the Wait-form is served by the same webhook type that had a critical vulnerability this year (CVE-2026-21858). Reviewers must come in over VPN; an authenticating proxy should expose only the form page (about a day of setup).
- Architect and pragmatist: once rules move into a separate service, B becomes C with a visual flow.
- Performance: pass file links between nodes, not file bytes, or large PDFs bloat n8n memory and database. GPU nodes should run one job at a time.

### C. Own pipeline: status table in Postgres + vLLM + reviewer form

The state of each document lives in a Postgres status table, which is the single source of truth. Each step is an idempotent worker in any language. The sandbox (gVisor) emits only rasters and text. Parsing is per page on vLLM (PaddleOCR-VL). Text extraction uses structured outputs. A second, vision-based extraction runs only as a cascade, when the first one fails the checks. The reviewer form is generated from the schema. A human decision is never written to the database directly: the writer service re-runs the rules first. Human corrections plus a random sample of auto-accepted records form the reference set used to measure quality.

Verdict: **this is the target, in minimal form**: one parser, one extractor, statuses in Postgres, a reviewer form. A second extractor, S3, a separate observability stack, and Temporal are added only when measurements show the need. No reviewer blocks this version. LangGraph or Temporal can be attached later if steps are idempotent.

- Performance had blocked double extraction for every document; resolved by making the second extraction a cascade.
- Security does not block under these conditions: only rasters and text leave the sandbox, model servers sit in a closed network, the reviewer UI never renders HTML.
- Critic: comparing two extractions does not catch a wrongly detected document type. Only rules and random sampling of accepted records catch that.

### Side by side

Time-to-first-result figures are the board's estimates, never measured.

| | A. Off-the-shelf | B. Builder | C. Own pipeline |
| --- | --- | --- | --- |
| First result | days | 1-2 weeks | a few weeks for the minimal version |
| Maintained by | administrator | developer; analysts can see flows | developers |
| Field schema per type | set of custom fields, flat | schema file from which the model request is built | schema registry: request, checks, form, and DB tables are built from it |
| Reason for human | tag and note | code and description in a form | several codes with descriptions |
| Field confidence and source | none | in the rules service | yes |
| Recognition | whatever paperless-gpt supports | any parser from the table below, same as C | any parser from the table below |
| License | GPL-3.0 (matters only if distributed) | n8n Sustainable Use License | MIT and Apache-2.0 |
| Main risk | the hook grows into variant C | webhooks and logic in Code nodes | amount of work before the first measurement |

## Models by hardware tier

The server is not chosen, so models are grouped by GPU memory. On OmniDocBench v1.6 (September 2026), small specialized 1-3B models outperform large general ones. Most figures are published by the model authors, so the final choice must rest on a measurement over 50-100 of our own documents.

| Tier | Page recognition | Field extraction | Notes |
| --- | --- | --- | --- |
| CPU only | Tesseract 5.5.3 (`ukr+rus+eng`) or Docling with RapidOCR `eslav` | Qwen3.5-4B GGUF via llama.cpp with a JSON schema | Docling at 3.1 s/page is about 52 min per 1000 scanned pages |
| ~8 GB | PaddleOCR-VL-1.6 (0.9B, 96.3 score) or GLM-OCR (1.8 GB in Ollama) | Qwen3.5-4B; 9B at Q4 barely fits | Two models do not fit together, so process in batches: recognize the whole batch first, then extract |
| 16-24 GB | Chandra 2 (Ukrainian 91%, handwriting) or dots.mocr / olmOCR 2 (>=12 GB) | Qwen3.5-9B on vLLM | Chandra 2 is free only up to $2M revenue; PaddleOCR-VL on vLLM needs Ampere or newer GPUs |
| 48-80 GB | PaddleOCR-VL or MinerU2.5-Pro for layout, Chandra 2 for hard pages | larger Qwen3.5 on vLLM | Recognizer and extractor stay in memory together |
| Cloud API | Mistral OCR, AWS Textract, Azure Document Intelligence | same, or local | Documents leave the server; whether that is allowed is decided per document class |

Cyrillic: PP-OCRv6 and Granite-Docling do not support it. Ukrainian is explicitly claimed only by Chandra 2 and Tesseract. There is no public benchmark for Ukrainian handwriting.

## Hosting

| Option | GPU memory | Price | Fits when |
| --- | --- | --- | --- |
| Hetzner GEX45, dedicated | 24 GB | EUR 214/month + EUR 209 setup | steady flow; data stays in the EU |
| Hetzner GEX63 | 96 GB | EUR 999/month + EUR 999 | high volume, several models at once |
| Scaleway L4 | 24 GB | EUR 0.79/h (~EUR 575/month) | batch processing a few hours a day |
| RunPod | 24-80 GB | L4 $0.44-0.59/h; H100 $1.99-2.89/h | measurements and one-off large batches |
| Mistral OCR 4, cloud API | n/a | $4 per 1000 pages ($2 batched) | low volume and documents may leave the server |
| Own server | any | one-time purchase | strict data requirements |

EUR 214/month for GEX45 equals roughly 57-115 thousand pages of Mistral OCR. If volume is lower and sending documents out is allowed, the cloud API is cheaper. Prices are from providers as of September-October 2026.

## Security baseline (any option)

The file itself is the biggest threat. LibreOffice, Apache Tika, Unstructured, and docling all had vulnerabilities in 2025-2026 where opening a document gave code execution, file reads, or network requests.

- Every program that reads raw file bytes runs in a container with no network, non-root, read-only filesystem, memory and CPU limits, and a timeout. Converters additionally run under gVisor.
- Type is determined by content. Limits apply to size, page count, compression ratio, and number and depth of attachments. An attachment's name is kept only as a description; the file is stored under its sha256.
- Ollama, vLLM, docling-serve, Tika, n8n webhooks, and Temporal are reachable only from the internal network. Only an authenticating proxy is exposed.
- The model has no tools and no database access. Its output is accepted only after JSON-schema validation, and a separate service writes to the database with parameterized queries.
- The reviewer sees page images, not the file itself, so a macro cannot run on their machine.
- Mail is accepted only from allowed senders; the SPF/DKIM result is recorded in the document's provenance.
- Retention periods are set for originals, text, reference set, and logs. A data protection impact assessment (DPIA) is done before launch, as required by GDPR and the Ukrainian personal data protection law.

## Decision

**Target: variant C in minimal form. Do not start with it; start with data.**

1. Collect 20-30 real documents of two or three types and fill in the fields by hand.
2. On 50-100 documents, measure the share of scans, seconds per page, and tokens per document. This can be a pilot of variant A or a simple measurement rig.
3. Only then choose the server and models.

Four decisions hold in every variant:

- The field schema is a versioned file per document type, with required fields. The model request, checks, form, and DB tables are all derived from it.
- Handoff reasons come from the closed list with description templates.
- For every field, store the verbatim source fragment and the normalized value.
- The reference set contains, besides human corrections, a small random share of auto-accepted records every time.

Execution route after approval: the pilot or measurement runs as direct-verified (run on 20-30 documents with a checklist). The minimal C is written spec-first with spec-kit in its own new repository; spec-kit is not set up there yet.

## Review board remarks

Confirmed by the interrogator:

- Versioned JSON Schema per type with required fields (author: architect).
- Closed list of reasons, several per document, description template with numbers (author: critic).
- Per-page routing: digital text read directly, only scanned pages go to OCR (author: performance).
- Only pixels, text, and coordinates leave the sandbox; model servers are protected by a closed network, not gVisor (author: security).
- Reference set = human corrections + random sample of auto-accepted records (author: critic).
- Vision extraction only as a cascade (author: performance).
- Mail only from allowed senders, gVisor from day one (author: security).

Dropped: Temporal in variant C (security objected without mTLS, architect withdrew, pragmatist objected).

Contested (unresolved):

- Reviewer UI: own form generated from the schema (architect) versus Label Studio Community with conditions (pragmatist; security: conditionally acceptable).
- Engine in C: Postgres status table with no engine (architect) versus LangGraph on top of it (pragmatist).

Rejected as weak:

- "Paperless OCRs a scan twice by default."
- "n8n pushes files through Redis" (withdrawn by its author).
- "Two extractions repeat each other's errors via shared OCR" (withdrawn by its author).
- "Paperless custom fields cannot have a per-type schema" (partly withdrawn by its author).

## Open questions

- Which server (GPU memory) and which implementation language?
- Reviewer UI: own form or Label Studio Community?
- Engine in C: no engine, or LangGraph over the status table?
- Variant B only: will non-developers edit flows, and will the product ever be offered as a service to third parties (n8n license)?
- Which document classes may be sent to a cloud API, if any?
- Retention periods and the DPIA owner.
