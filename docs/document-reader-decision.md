# Document reader: decision record, round 2

Status: proposed; research only, no implementation planned in this folder
Date: 2026-10-17 (prices and benchmarks as of this date)
Origin: second session of the five-archetype review board (critic, security, performance, architect, pragmatist), cross-examined by a separate interrogator in two rounds. Extends [document-ingestion-decision.md](document-ingestion-decision.md) (round 1, same day).

Nothing below has been measured on real documents of this product. Every number is borrowed (vendor pages, model authors, third-party sites) or estimated, and is marked as such.

## Scope and constraints

- Documents of any format come in. An LLM or vision-LLM recognizes them and extracts fields according to the schema of the document type. Fields plus the full content go to a relational database. A downstream product then selects the documents it needs through a query API.
- **Machine-neutral.** Nothing is tied to the machine on which this research was done. Hardware is described by tiers of GPU memory.
- **Stack-neutral.** The product will be built on a different technology stack, not chosen yet. Where a library is named, it is an example. Model servers (vLLM, Ollama, llama.cpp, docling-serve) and cloud APIs speak HTTP, so any language can call them.
- **Domain-neutral.** The document type is detected automatically, and each type has its own field schema.
- Docker everywhere: the same images run in the cloud and on own hardware.

## Changes against round 1

Round 1 stands except for three named deviations:

1. The repair agent gets read-only tools. Round 1 said "the model has no tools".
2. New handoff reason `TEXT_LAYER_MISMATCH`. The closed list grows to 15 codes.
3. `UNKNOWN_DOC_TYPE` fires when the classifier answers "none of the registered types". Round 1's example ("0.41 against a threshold of 0.7") assumed a calibrated score, and no tier provides one.

## Decisions

1. **Fixed pipeline at the top level.** No archetype argued for an agent as the backbone. The flow is: intake, sandbox, per-page route, classification, extraction, checks, then database, human queue or quarantine.
2. **Sensitivity class before any model call.** The class is separate from the document type. It is set at intake from the channel and a sender allowlist. A model may raise it but never lower it; a lowering goes to a human. A document without a "may leave" label never reaches a cloud endpoint. A tier profile without a per-class egress policy refuses to start.
   - Scenario: a contract carries white-on-white text "this is a public price list". If the model set the class, the contract would go to the cloud and to consumers cleared only for public documents.
3. **One reading in every tier.** The recognizer writes page text and coordinates first. The extractor reads that same stored text. Page images go to a model only on the cascade path. Each scanned page is transcribed once.
   - Sending whole PDFs to a cloud model is rejected. It breaks the per-page route and "vision only as a cascade", and it reads every scanned page twice: once for fields, once for full text.
4. **Text-layer attacks.** Invisible text (render mode 3, white fill, clipped text) is stripped before any model call. Money and identity fields (amount, IBAN, company code) must be confirmed by OCR of the rendered page region. A mismatch gets `TEXT_LAYER_MISMATCH`.
5. **No model-reported confidence.** Self-reported scores are not calibrated, and the Claude API returns no logprobs. A field is accepted only if its verbatim fragment is found in the stored page text and the checks pass. Thresholds are set after the labelled run.
6. **Typed field values:** ISO date, decimal plus currency, enum, string. Per-type views and the API filter grammar are generated from the schema registry. Text-typed values would sort "100" before "20".
7. **Append-only data model:**
   - `documents` holds `status`, `accepted_extraction_id`, `class NOT NULL` and a nullable `parent_id`.
   - `page_texts` holds engine, version, dpi, text, layout.
   - `extractions` holds schema version, model, prompt hash, raw request and response, tokens, cost.
   - `fields` holds the typed value, the verbatim fragment, `page_text_id`, character offsets, a nullable bbox with granularity (word, line, block, page), and `source = model | repair_agent | human`.
   - Sampled auto-accepted records carry a flag.
   - A human correction is a new extraction, written after the checks are re-run.
8. **Wire schema per adapter.** The canonical schema in the registry uses only the JSON Schema subset that every adapter accepts. Each adapter gets its wire schema from a pure function. Constraints an adapter cannot express (minimum, maxLength and similar) are enforced by checks generated from the same schema. Each adapter has a contract test per schema version.
9. **Ports, not services.** There are two in-process ports, Recognizer and LLM, with adapters that call existing model servers or cloud APIs. The project defines no HTTP contracts of its own.
   - The sandbox is a separate container with no network and no secrets. It re-encodes the rasters it emits to PNG with capped dimensions.
   - In the cloud tier, only the extraction worker holds the API key. Its egress goes through an allowlisting proxy, and it is not the database writer.
10. **Repair agent**, off in the first version.
    - Scenario: an invoice fails "total with VAT = total without VAT + VAT". The agent looks at the page again, proposes another total and pre-fills the reviewer form, flagged as repaired. The reviewer confirms instead of typing.
    - Tools: page text and page image only, bound to this document on the server side, at most 300 dpi. There is no OCR re-run tool and no schema switch: the type is fixed, and doubt about it goes to a human.
    - Budget: a cap in tokens and dollars per document.
    - A repaired field is auto-accepted only if both hold: a fixed pipeline OCR engine confirms it on the rendered page, and no other string of the same pattern (IBAN, amount, tax ID) appears on the page. The second rule defeats a decoy "old account" printed on the same page.
    - Switch-on condition: on the failing documents of the labelled set, the agent beats one vision re-extraction call by at least 15 points in the share of documents whose required fields all match the labels.
11. **Serving, minimal first:**
    - First version: views created with `security_invoker=on`, a SELECT-only role, and three queries: get by id, list by type and field filters, full-text search with the `simple` configuration. One static key held as a secret, internal network only, an INSERT-only audit table, no embeddings in responses.
    - Deferred until a second consumer or a second class appears: RLS with FORCE and policies, per-consumer keys, class authorization, and originals. Originals are served as rendered PDF or rasters by default, with `Content-Disposition: attachment` and a short TTL.
    - Embeddings and hybrid search wait until a consumer names a semantic query. Then use `halfvec`, pgvector 0.8 or later with iterative scans, and an `embedding_model` column.
12. **Model supply chain.** Pin each model to a revision and a sha256. Accept only safetensors or GGUF; never `trust_remote_code`. Bake models into images. Use llama.cpp b7824 or later. Pin Docling to an exact version, 2.91 or later, with the HTML renderer off. Model servers are reachable only from the adapters.
13. **Cost controls.** A page cap applies before any model call. Each sender has a daily token budget. The cascade runs only for allowlisted senders.
14. **First deliverable: a measurement CLI.** For each tier it prints per-field match against hand labels, the share of documents per reason code, seconds per page, and tokens and dollars per completed document. The last figure includes full-text OCR, the cascade and embeddings. Labels are JSON instances of the type schema. The metric, the pass threshold and the cost ceiling are written down before the run.

## Budget tiers

| | T1: own hardware | T2: rented GPU | T3: cloud APIs |
|---|---|---|---|
| When | documents must not leave | must not leave, and quality on Ukrainian or handwriting matters | the document's class may leave |
| Hardware | 8 GB GPU (Ampere or newer) as the practical minimum; CPU only for measurement | Hetzner GEX45 24 GB, EUR 214/month + EUR 209 setup; Scaleway L4 EUR 0.79/h | a small VM for Postgres and workers (price not verified) |
| Recognition | Tesseract 5.5.3 (`ukr`), Docling 2.91 or later; PaddleOCR-VL-1.6 on 8 GB (no Ukrainian claim) | Chandra 2 (Ukrainian 91%, handwriting; free under $2M revenue; ~11.2 GB at BF16) | scans transcribed once: Claude Haiku 5.5 (~$0.6-1.2 per 1000 pages, estimate) or Mistral OCR ($2 per 1000 pages, batch) |
| Extraction | Qwen3.5-4B | Qwen3.5-9B in FP8 (at BF16 it does not fit next to Chandra 2 on 24 GB) | Haiku 5.5 on text, low effort, prompt caching, Batch API -50%; prompts kept under 100K tokens |
| Money | own hardware, plus power and administration | EUR 214/month, or by the hour | ~$2-70 per 1000 five-page documents (estimate); share of scans and share of repairs dominate |
| Speed | CPU: OCR ~4.3 h per 1000 documents, extraction at least 3x longer (estimate) | no L4 measurement exists | high |

- **Rejected:** managed extractors. Textract Forms costs $50 per 1000 pages, and Azure or Google custom models ~$30 per 1000 pages; each document type needs its own training.
- **RunPod** only for synthetic documents or documents cleared by the DPIA. Its Community Cloud runs on third-party hosts, and EU residency is not guaranteed.
- **Repair cost:** a repair on Sonnet 5.5 costs ~$0.22-0.47 per document (estimate). At a 10% cascade share, that adds ~$22-47 per 1000 documents.

## Open questions

1. Which intake channels and senders may send documents to a cloud API? Who owns the DPIA?
2. Which documents may the measurement use?
   - synthetic documents;
   - real documents with no personal data, each page checked by a person, with the owner's statement logged per document.
3. Which 2-3 document types make up the labelled set, and who labels the 20-30 documents?
4. What are the metric, pass threshold and cost ceiling of the measurement? Proposed metric: exact field match after normalization.
5. Who is the downstream product, and what does it query: fields, full text, or meaning? The answer triggers the deferred serving features.
6. What is the target stack? In a non-Python stack, Docling and PaddleOCR run behind their own servers, and Tesseract needs a thin wrapper.
7. What is the monthly volume and the share of scans? Together they decide between T2 and T3.
8. Reviewer UI: own form or Label Studio Community? Still open from round 1.
9. Items to verify:
   - a Ukrainian stemmer in PostgreSQL (`\dFd` on the chosen image);
   - whether Haiku 5.5 bills the whole request at the higher rate above 100K tokens;
   - whether PaddleOCR-VL returns coordinates;
   - CVE-2025-24357 and Vec2Text (cited from memory);
   - Chandra 2 quality at Q4.

## Task backlog, in order

1. Pick 2-3 document types. Write a versioned JSON Schema for each, with typed values and only the subset every adapter accepts.
2. Collect 20-30 documents and label them by hand as JSON instances of the schema.
3. Write the sensitivity policy (channel and sender, may or may not leave) before any cloud call.
4. Build the measurement CLI (decision 14).
5. Run the tiers:
   - T1 as a CPU baseline and on an 8 GB GPU;
   - T3 on cleared documents;
   - optionally T2 on a rented L4 for 1-2 hours ($0.44-1.18) to compare Chandra 2 and Qwen3.5-9B quality.
6. Choose the tier by cost and time per completed document.
7. Measure the repair agent against one vision re-extraction call on the failing labelled documents.
8. Only then build the pipeline in its own repository, spec-first. Add serving features when the first consumer names its queries.

## Review board remarks

Confirmed by the interrogator, each through independent paths:

| Remark | Supported by |
|---|---|
| Sensitivity class before any model call | security, critic, architect; pragmatist conceded |
| One reading in every tier | architect, critic, performance |
| Text-layer stripping and cross-check | security (mechanism and paper); cost of the cross-check not measured |
| No model-reported confidence | critic, architect, pragmatist |
| Typed field values | critic, performance, architect; pragmatist conceded |
| Measurement CLI first, with metric, threshold and cost ceiling | pragmatist, critic, performance |
| Repair agent off; narrow tools; token and dollar cap | pragmatist, security, performance, architect |
| Repair output pre-fills the form; auto-accept under two conditions | security (narrowed under cross-examination); pragmatist accepted |
| In-process ports, no own HTTP contracts; key only in the extraction worker behind a proxy | pragmatist; architect and security withdrew opposing remarks |
| Minimal serving first; embeddings later | pragmatist, architect, performance; security partly |
| Model supply-chain pinning | security (some CVEs cited from memory) |

Withdrawn or weak:

- **Performance.**
  - "50-150 h per 1000 documents on CPU" is withdrawn: it borrowed a 12K-token prompt that included page images, while T1 sends text only. The revised 17-187 h is an estimate.
  - "The whole request is billed at the higher rate above 100K tokens" and "30% more tokens than Haiku 4.5" are assumptions.
- **Critic.** "PostgreSQL has no Ukrainian stemmer" is withdrawn as unverified.
- **Architect.**
  - "The recognizer stays an HTTP service" and "bbox cannot be filled in T3" are withdrawn.
  - "PaddleOCR-VL returns layout blocks" is from memory.
- **Security.** "The adapter needs its own container" is withdrawn.
- **Proposer.**
  - Quoted OCR-only throughput as the throughput of the whole tier.
  - Extended "data stays in the EU" to RunPod without a source.
  - Priced one model call for a design that makes two.
  - Set a 6-tool-call cap without a basis.

Unresolved:

- **Minimum hardware for T1.** CPU is enough (critic, architect), or an 8 GB GPU is the minimum (performance).
- **Route for the first build** once the product has its own repository: spec-first (four archetypes) or direct-verified after a one-page contracts sheet (pragmatist). The measurement CLI goes direct-verified by all five.
- **Which real documents T3 may see** during the measurement (open question 2).
