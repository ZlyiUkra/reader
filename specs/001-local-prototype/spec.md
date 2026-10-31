# Feature Specification: Local Prototype of the Document Reader

**Feature directory**: `specs/001-local-prototype` (the work happens on the `main` branch; there is no feature branch)

**Created**: 2026-10-31

**Status**: Analysed on 2026-10-31, ready for implementation

**Input**: User description: "Local Docker prototype of the document reader, as agreed by the five-archetype review board on 2026-10-17: handoff `.specify/consilium/2026-10-17-local-prototype.md`, verdict approved-with-conditions, conditions C1-C17, acceptance checks 1-14, route speckit with Agile Tasks."

The owner wants to see the document-reading idea work end to end on one machine before any product decision. Documents of many formats go in, a local language model recognises each one and extracts its fields, the results and their evidence are visible in a browser, and an evaluation prints numbers that say how well and how fast it works. The prototype is a demonstration and a measuring instrument, not the product. It keeps the invariants of the earlier board rounds (`docs/document-ingestion-decision.md`, `docs/document-reader-decision.md`) and the constitution (version 1.0.0) true in a small working system, so that later steps (a cloud model, a human review form, deployment to a cluster) are additions, not rewrites. Condition numbers (C1-C17) and acceptance check numbers in brackets point to the handoff for the full wording.

## Clarifications

### Session 2026-10-31

- Q: Does "Read folder" descend into subfolders of the inbox, and what happens to hidden files and the generator's own files? -> A: Top level only; dot-files and the generator's manifest and expected-value files are skipped.
- Q: Does the evaluation leave a file behind, or only print to the screen? -> A: Both: human-readable text on the screen and one JSON report file per run in a results folder, named by run date and model identity, with the same figures.
- Q: Does the document detail view show the raw model request and response? -> A: Yes, as a collapsed plain-text block, fetched by a separate per-document request; the list endpoint still never carries them.
- Q: Which interface language opens first, and is the switch remembered? -> A: Ukrainian by default; the browser remembers the chosen language between visits; English stays available through the switch at all times.
- Q: What identifies a document for the owner in the table and in the DUPLICATE answer? -> A: A short sequential number as the visible id, used in the table, the detail view and the DUPLICATE answer; the content hash stays the identity and is shown in the detail view.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the synthetic folder end to end (Priority: P1)

The owner generates the synthetic document set into the inbox folder, opens the browser view, presses "Read folder", and watches eleven documents travel through recognition, classification, extraction and checks to a final status. Six are accepted, three need review because a required field is missing, one needs review because its amounts do not add up, and one needs review because its type is unknown.

**Why this priority**: This is the whole idea in one run. Without it nothing else can be demonstrated or measured.

**Independent Test**: Start the system from empty storage, generate the fixtures, press "Read folder", wait for the bound written in the thresholds file, and compare the documents table with the expected outcomes of the fixture manifest.

**Acceptance Scenarios**:

1. **Given** a running system with the model ready and eleven fixtures in the inbox, **When** the owner presses "Read folder", **Then** within the bound of the thresholds file every document has a terminal status: 6 ACCEPTED, 3 NEEDS_REVIEW with `MISSING_REQUIRED_FIELD`, the wrong-VAT invoice NEEDS_REVIEW with `VALIDATION_FAILED`, the untyped document NEEDS_REVIEW with `UNKNOWN_DOC_TYPE` and no field rows (check 4).
2. **Given** the run above, **When** the owner inspects any document that is not ACCEPTED, **Then** it shows at least one reason code with a message rendered from that code's template and filled parameters (check 4).
3. **Given** the run above, **When** the owner presses "Read folder" a second time, regenerates the fixtures, or copies one fixture under a new name and reads again, **Then** the documents count does not change and each repeated file is reported as `DUPLICATE` with the original's number (check 5).
4. **Given** the model is stopped, **When** a document is read, **Then** it stays queued, the health view shows the model as missing, and once the model is back the document completes with zero attempts spent during the outage (check 11).

---

### User Story 2 - See a document's evidence (Priority: P1)

The owner opens a document from the table and sees the fields that were extracted, the verbatim fragment each value was read from, the page it was found on, the rendered page images, which model ran and how long each step took. For a document that was not accepted, the reasons are shown in plain words.

**Why this priority**: Accepting a value without checkable evidence is what the board rejected. The detail view is how the owner judges the model's work.

**Independent Test**: Process one accepted fixture and one fixture with a missing field; open both detail views and verify fragments, pages, timings and the rendered reason.

**Acceptance Scenarios**:

1. **Given** an ACCEPTED document, **When** its detail view opens, **Then** every field shows its typed value, the verbatim fragment, the page number and that the fragment was found in the stored page text; the view also shows the model identity, the schema version and the duration of each pipeline step.
2. **Given** any document with at least one extraction, **When** the owner expands "Model request and response" in the detail view, **Then** the raw request and the raw response of each extraction are fetched for that one document and shown as plain text, collapsed by default.
3. **Given** a NEEDS_REVIEW document, **When** its detail view opens, **Then** every reason is shown as a rendered message (for example `Required field "Contract date" not found.`), never as a bare code.
4. **Given** any document, **When** its page images are shown, **Then** they are rendered previews of capped width, loaded lazily, and the original file is never offered for download or display (C15).
5. **Given** the documents table, **When** it refreshes (every 2 seconds), **Then** it shows status, type and reason codes, and never carries page texts or raw model requests and responses (C15).

---

### User Story 3 - Upload a document from the browser (Priority: P2)

The owner drops a file into the browser view. It is stored under its content hash, classified into the most restrictive sensitivity class because it did not come from the fixtures generator, and goes through the same pipeline as a folder document.

**Why this priority**: The second intake channel of the prototype; it also exercises the sensitivity class rule on a document that is not synthetic.

**Independent Test**: Upload a fixture copy and a non-fixture file; verify the class of each, the duplicate answer for the copy, and the pipeline result for the new file.

**Acceptance Scenarios**:

1. **Given** a file whose content hash is not known, **When** it is uploaded, **Then** a new document appears with class `unverified`, and it reaches a terminal status like a folder document (check 6).
2. **Given** a file whose content hash is already known, **When** it is uploaded under any name, **Then** the response reports `DUPLICATE` with the original's number and no new document is created (C3).
3. **Given** a fixture listed in the generator manifest, **When** it is read or uploaded, **Then** its class is `synthetic`; a file outside the manifest never receives `synthetic` (C2).

---

### User Story 4 - Measure the run (Priority: P2)

The owner runs the evaluation command after a folder run. It compares results with the expected values of the fixtures and prints per-field match, the share of each reason code, seconds per page split into parsing and model time (cold and warm separately), tokens per document, false accepts, and the identity of the model, schemas and prompt. It fails when the result is below the threshold written in this specification before the first run.

**Why this priority**: The board's standing verdict is "measure first". Every later tier and model decision depends on these numbers, and the prototype exists to produce them.

**Independent Test**: Run the evaluation on the completed fixture run and on a deliberately degraded run (for example with one expected value changed) and verify the printed figures and the exit code.

**Acceptance Scenarios**:

1. **Given** a completed folder run, **When** the evaluation runs, **Then** it prints every figure listed in the Measurement Contract below and states "not a tier decision" (check 14).
2. **Given** a result below the pass threshold, **When** the evaluation runs, **Then** it exits with a non-zero code and names the threshold (check 14).
3. **Given** the model is stopped, **When** the test suite runs, **Then** the pipeline tests pass using stored model responses, without a GPU (check 9).

---

### User Story 5 - Operate the prototype (Priority: P3)

The owner starts everything with one command, sees in the health view whether the database, the model and the sandbox are ready, sees the list of named simplifications in the page header, and can stop and restart without losing or duplicating documents.

**Why this priority**: Operability is what makes the demonstration repeatable on the owner's machine; it is lower than the pipeline itself.

**Independent Test**: Start from empty storage, confirm the health view and the header, stop and start again with storage kept, confirm nothing is downloaded again and no document is failed because of start-up order.

**Acceptance Scenarios**:

1. **Given** empty storage, **When** the system starts, **Then** the model download job completes, the health view shows the database ok, the model ready, the sandbox runtime name and a non-empty TODO list, the TODO list is visible in the page header, and no document is FAILED because the model was not ready (check 2).
2. **Given** storage kept from a previous start, **When** the system starts again, **Then** nothing is downloaded (check 2).
3. **Given** a running system, **When** the owner inspects it from the host, **Then** the model's port is not reachable, the parser has no network interface other than loopback, runs as a non-root user and cannot write to its root, and the user interface answers only on the loopback address (check 3).
4. **Given** the configuration lacks an egress rule for one sensitivity class, **When** the application starts, **Then** it exits with a non-zero code and names the class (check 6).
5. **Given** the stored schema version differs from the one the application expects, **When** the application starts, **Then** it refuses to run and says so (C12).

---

### User Story 6 - Register a new document type (Priority: P3)

The owner adds a new versioned type schema file and restarts. The classifier offers the new type without any other change.

**Why this priority**: It proves the registry is the single source for types, which the constitution requires; it is not needed for the first measurement.

**Independent Test**: Add `receipt` as a fourth type schema and restart; inspect the next classification request.

**Acceptance Scenarios**:

1. **Given** a new schema file for a type called `receipt`, **When** the application restarts, **Then** the next classification request lists "receipt" among the types (check 10).

---

### Edge Cases

- A password-protected file ends REJECTED with `ENCRYPTED`; a damaged file ends REJECTED with `CORRUPT`; an unsupported format ends REJECTED with `UNSUPPORTED_FORMAT`; each with a rendered message.
- A 5000-page PDF or a 30000 x 30000 pixel image ends REJECTED with `TOO_LARGE` after a single attempt, with the breached limit in the message, and every other service stays up (check 8, C6).
- A conversion or recognition tool that breaches its own time or memory limit on a file ends the document REJECTED with `TOO_LARGE`, no retry (C6).
- The parser's output contains a symbolic link, a hard-linked file or an oversized manifest: the job fails and nothing is read or served (check 7, C8).
- The model server does not answer, the container dies without a result, or the model returns invalid JSON: the document gets `INTERNAL_ERROR`, is retried, and is FAILED after three attempts (C6, check 9).
- A step's lease expires because the worker died: the expiry counts as an attempt and the document is picked up again; on restart the single worker requeues the documents it left in progress (owner decision, named simplification).
- The prompt would exceed the model's context budget: the document ends with `TOO_LARGE` before any model call (C7).
- The model stops generating because it hit the generation cap: the document ends REJECTED with `TOO_LARGE` naming the generation cap as the breached limit, and is not retried (C7).
- A field's verbatim fragment is not found in the stored page text: the field is not accepted and the document gets `VALIDATION_FAILED` with the template `Field "{field}": the quoted fragment "{fragment}" is not in the text of page {page}.`; `LOW_CONFIDENCE` is never used for this (C1).
- Scanned pages are unreadable: `LOW_OCR_QUALITY`; pages are blank: `EMPTY`; both with the cut-off values from the thresholds file in the message.
- The classifier answers "none of the registered types": NEEDS_REVIEW with `UNKNOWN_DOC_TYPE` and zero field rows; no extraction runs.
- A browser request arrives with a foreign Host or Origin, or a state-changing request lacks the same-origin marker: it is refused with 403 or 421 and nothing changes (check 13, C15).
- The folder is read while the model is missing: documents stay queued, no attempt is spent, health shows the model as missing (check 11).
- A document is read again after it ended REJECTED or FAILED: its content hash is known, so it is reported as `DUPLICATE` and is not processed again (see the Re-read Cases table).
- Two documents of different types are present in one file: out of scope; the classifier picks one type or "none".
- A subfolder, a dot-file or a generator file (manifest, expected values) sits in the inbox: "Read folder" neither lists nor reads it.

## Requirements *(mandatory)*

### Functional Requirements

Intake and identity

- **FR-001**: The system MUST accept documents from a local inbox folder, read only when the owner asks ("Read folder"), and from a browser upload.
- **FR-002**: The system MUST identify every document by the hash of its content (sha256). The file name and path are stored as descriptions only and never decide identity or processing (C3). Each new document MUST receive a short sequential number as its visible id; the table, the detail view and the `DUPLICATE` answer use that number, and the detail view also shows the content hash.
- **FR-003**: When a document's content hash is already known, the system MUST report `DUPLICATE` with the original's number in the upload response or the folder-read result, MUST NOT store the document again, and MUST NOT change the documents count (owner decision, C3).
- **FR-004**: The system MUST store an uploaded file to disk as a stream under its content hash, with explicit size limits, and keep the original name only as metadata (C8).
- **FR-005**: Reading the folder MUST consider only the regular files at the top level of the inbox: subfolders, files whose name starts with a dot, and the generator's own files (the manifest and the expected-value files) are skipped and not listed. Listing does not hash; hashing and intake happen only when the owner asks for the read.

Sensitivity class and egress

- **FR-006**: The system MUST assign every document a sensitivity class at intake by one declared rule: `synthetic` only when its content hash appears in the fixtures generator manifest, `unverified` for every other document. Class and document type are separate attributes; the class is mandatory (C2).
- **FR-007**: The closed list of classes MUST carry, per class, whether its content may leave the machine. The system MUST refuse to start if any class lacks this rule, naming the class (C2, check 6).
- **FR-008**: The model port dispatcher MUST refuse a non-local model adapter for any document whose class may not leave. In this prototype only the local adapter is connected (C2).

Recognition in isolation

- **FR-009**: Every program that reads raw document bytes MUST run in an isolated parser environment with no network, a read-only root, a non-root user, dropped privileges and numeric limits on memory, processes and temporary storage (C9, check 3).
- **FR-010**: The parser MUST detect the format from the file's content, not from its name or extension.
- **FR-011**: The parser MUST turn every supported document into page texts and rendered page images, reading digital text layers directly and applying OCR (Ukrainian and English) only to pages without a text layer; each page is read once and the reading is stored with its source (text layer or OCR), engine, version, resolution and timings (C12).
- **FR-012**: The parser MUST enforce a page cap right after conversion, check page count and page size before rendering, check image dimensions, and run one office conversion at a time (C9).
- **FR-013**: Each parsing job MUST run as a fresh child process with its own temporary directory and office profile, under its own time and memory limits set below the environment's limits; leftover processes MUST be terminated after the job (C8).
- **FR-014**: The application MUST read parser output defensively: only the folder of the job in flight, emptied before dispatch; fixed file name patterns; no path taken from a manifest; no symbolic or hard links followed; size caps on manifest, images and page count checked before reading; image signatures and header dimensions checked; the manifest validated against a versioned schema that forbids unknown properties (C8, check 7).
- **FR-015**: The application itself MUST NOT parse document bytes.

Classification, extraction and evidence

- **FR-016**: The system MUST classify each document as one of the registered types or "none", using a closed list derived from the schema registry; "none" ends the document in NEEDS_REVIEW with `UNKNOWN_DOC_TYPE` and no field rows.
- **FR-017**: The system MUST extract the fields of the detected type in one model call that returns, for each field, a value, the verbatim fragment it was read from and the page; the request schema MUST be derived from the type schema (C10).
- **FR-018**: The system MUST locate each field's verbatim fragment in the stored page text using one pinned normalisation (whitespace, apostrophe variants, OCR line breaks) and MUST compute the page and character offsets itself; the model's own value and page are kept only in the raw response (C12, constitution V).
- **FR-019**: The system MUST derive the typed value from the located fragment (ISO date, integer money in kopiyky, enumeration, string) and MUST NOT accept a field whose fragment was not found or whose checks failed (constitution VI).
- **FR-020**: The system MUST NOT use any confidence reported by the model.
- **FR-021**: The system MUST run deterministic checks written as rules: the VAT rule (net plus VAT equals total, exact integer comparison) and the VAT rate, date order, EDRPOU checksums and Ukrainian IBAN checksums; a tolerance that lets the wrong-VAT fixture pass is a defect (C11).
- **FR-022**: Before each model call the system MUST check the prompt against the context budget using a characters-per-token ratio calibrated in the evaluation; over budget ends the document with `TOO_LARGE`. A generation cut off at the generation cap (the model server reports the stop reason "length") ends the document REJECTED with `TOO_LARGE`, the cap named as the breached limit, and MUST NOT be retried (C7).
- **FR-023**: The system MUST run one model call at a time and MUST never hold a database row lock while a model call is in flight (C7).

Reasons and status

- **FR-024**: One reasons file MUST declare all 15 codes (`ENCRYPTED`, `CORRUPT`, `MALWARE`, `TOO_LARGE`, `UNSUPPORTED_FORMAT`, `DUPLICATE`, `LOW_OCR_QUALITY`, `UNKNOWN_DOC_TYPE`, `MISSING_REQUIRED_FIELD`, `VALIDATION_FAILED`, `LOW_CONFIDENCE`, `EMPTY`, `INTERNAL_ERROR`, `EXTRACTORS_DISAGREE`, `TEXT_LAYER_MISMATCH`), each with its outcome, a message template with named parameters in each interface language (FR-058), its trigger and the step that emits it. The prototype emits 11; `MALWARE`, `LOW_CONFIDENCE`, `EXTRACTORS_DISAGREE` and `TEXT_LAYER_MISMATCH` are reserved and never emitted (C1).
- **FR-025**: A document MUST be able to carry several reasons at once; each stored reason is a code plus parameters, and messages MUST be rendered from the template, never written freely by a model (C1).
- **FR-026**: Document status MUST be computed by one function of the reasons, the attempts and whether checks are done, in this order of precedence: rejection codes give REJECTED; `INTERNAL_ERROR` with three or more attempts gives FAILED; `INTERNAL_ERROR` with fewer attempts keeps the step pending; review codes give NEEDS_REVIEW; no reasons with checks done gives ACCEPTED; otherwise the current step's status. `DUPLICATE` is reported at intake and never reaches the function (C1).
- **FR-027**: Failures MUST map as follows: a tool over its own time or memory limit on a file gives REJECTED `TOO_LARGE` without retry; a tool error caused by the file gives REJECTED `CORRUPT`; infrastructure failure, a model timeout or invalid model output gives `INTERNAL_ERROR` with retry and FAILED after three attempts; a model reported missing gives no claim and no attempt (C6).
- **FR-028**: NEEDS_REVIEW is a terminal status in this prototype; no review action exists (named simplification).

Pipeline state and data

- **FR-029**: The document status table MUST be the only record of where a document is; no file, memory or other store may hold pipeline state (constitution III).
- **FR-030**: Each pipeline step MUST be idempotent, and a step's state change and its output MUST be committed together; stored data MUST be append-only: new readings, extractions and fields are added, never overwritten (C12).
- **FR-031**: Work MUST be claimed with a per-step lease whose length is the sum of that step's timeouts; an expired lease counts as an attempt; on start the single worker MUST requeue the rows it left in progress (owner decision).
- **FR-032**: For every extraction the system MUST record the model identity, the schema version, the prompt hash, the raw request and response, the generation stop reason, and the model's load, prompt and generation counts and durations; for every page text the source, engine, version, resolution and per-step parser timings; for every field the typed value, the fragment, the page text reference and offsets, whether it was found, and its source (C12).
- **FR-033**: Stored file references MUST be relative to a configured root, never absolute host paths (C12).
- **FR-034**: The application MUST check a schema version marker at start and refuse to run on a mismatch; a schema change means a reset of storage (named simplification: no migrations).
- **FR-035**: The database role used by the application MUST NOT be a superuser; identifiers MUST come only from the schema registry and all queries MUST be parameterised (C10, C12).

Model readiness

- **FR-036**: Model weights MUST be fetched by a one-off job on a network with egress into a shared volume, pinned by tag and verified by digest; the serving model MUST sit on an internal network only and its port MUST never be published (C5, check 3).
- **FR-037**: The application MUST start at once and report the model as `missing` or `ready`, where ready means the pinned digest is present and a warm-up call has passed; the worker MUST claim no model step while the model is not ready and MUST spend no attempt on it (C5, check 11).
- **FR-038**: A failed download MUST block nothing when the weights are already present; a second start with storage kept MUST download nothing (C5, check 2).
- **FR-039**: Every model response MUST be validated against the request schema regardless of what the server claims; a contract test MUST confirm that five of five replies for the invoice schema parse and validate before the model is trusted (C4, check 1).

Schema registry

- **FR-040**: Each document type MUST have exactly one versioned schema file, with the version in its identifier; the business rule "required" is expressed only by the standard required marker (C10).
- **FR-041**: The classification list, the prompt and its hash, the request schema per adapter, the checks, the field labels and order shown in the browser, and the fixtures' expected values MUST all derive from the registry; nothing is maintained by hand in parallel (C10, constitution II).
- **FR-042**: The request schema per adapter MUST be a pure function of the type schema: no vendor-specific keys, every field present with an explicit "absent" alternative, and only the schema subset the adapter accepts (C10).
- **FR-043**: Adding a type schema file and restarting MUST make the new type appear in the next classification request without other changes (check 10).

Fixtures

- **FR-044**: A one-off generator MUST produce the synthetic set reproducibly: fixed dates, a fixed seed, and a manifest listing the content hash of every file it writes; repeated runs MUST produce identical hashes (C3, C17).
- **FR-045**: The set MUST contain three types (invoice, act of completed works, contract), each in three documents, spread over text PDF, scanned PDF, PNG, JPG, SVG, DOC, DOCX, RTF and XLSX, plus two bad documents: an invoice whose VAT is off by at least 1 UAH and a document of no registered type. Within each type exactly one document lacks one required field (owner decision, C11, C17).
- **FR-046**: Fictional companies in the fixtures MUST carry valid EDRPOU and IBAN checksums, and Ukrainian text; scans and photos MUST be produced from the rendered pages with rotation, blur and noise (C17).
- **FR-047**: For every fixture, the generator MUST write the expected result as an instance of the type schema plus the expected status and codes, keyed by content hash and produced from the same data that filled the template (C14).

Evaluation

- **FR-048**: An evaluation command MUST compare the stored results with the expected results and print: per-field match, the share of each reason code, seconds per page split into parsing and model time with cold and warm starts separate, tokens per document, false accepts listed separately, and the model identity, schema versions and prompt hash (C14).
- **FR-048a**: The evaluation MUST also write one JSON report file per run into a results folder, named by the run date and the model identity, carrying the same figures, the thresholds in force and the pass or fail verdict; the measurement journal in the README and the project dashboard take their numbers from this file, never from a copy of the screen text.
- **FR-049**: The evaluation MUST exit non-zero when the result is below the pass threshold of the Measurement Contract and MUST print "not a tier decision" (C14).
- **FR-050**: A replay model adapter fed from stored raw responses MUST exist so that the pipeline tests, the status function table test over all 15 codes, the request-schema snapshots per type, the parser manifest validation and the three-failures-to-FAILED path all run without a GPU (C14, check 9).

Thresholds and named simplifications

- **FR-051**: Every tunable number (context size, generation caps, timeouts, page cap, OCR resolution, OCR quality cut-off, empty-page rule, scanned-page rule, image caps, the run bound) MUST live in one thresholds file, each value marked "provisional, unmeasured" until the evaluation measures it, and MUST be stored with every page text and extraction it governed (C13).
- **FR-052**: Every named simplification (see Deferred Simplifications) MUST be visible as a start-up warning and as an entry of the health view's TODO list, which the browser page MUST show in its header (constitution XII, check 2).

Browser view

- **FR-053**: The browser page MUST offer three views: the inbox folder contents with a "Read folder" action and an upload control; the documents table with status, type and reason codes, refreshed every 2 seconds; and a document detail view with fields, fragments, pages, model identity and step durations (C15).
- **FR-053a**: The detail view MUST offer the raw model request and response of each extraction in a block that is collapsed by default and rendered as plain text; they are fetched by a separate request that serves one document at a time (the documents table endpoint never carries them, FR-054).
- **FR-054**: The documents table endpoint MUST never return page texts or raw model requests and responses; page images MUST be served as images with a no-sniff marker, previews capped at about 1,240 pixels wide and loaded lazily; originals MUST never be served (C15).
- **FR-055**: The page MUST render document text, fragments and reason messages as plain text only; no HTML or markdown rendering of document content (C15).
- **FR-056**: The user interface MUST listen only on the loopback address. The server MUST reject requests with a foreign Host, and state-changing requests without a same-origin marker and the custom header, with 403 or 421 and no side effect; the content security policy MUST allow only the page's own origin (C15, check 13).
- **FR-057**: The browser page MUST offer its texts in two languages, Ukrainian and English, with a language switch; the choice applies to labels, buttons, field names and rendered reason messages alike (owner decision of 2026-10-31). Ukrainian is the default; the browser remembers the chosen language between visits without any server-side state, and English MUST stay reachable through the switch at all times.
- **FR-058**: Every field label in the schema registry and every message template in the reasons file MUST exist in both languages; a label or template missing in one language is a defect caught by a test, and a rendered message MUST follow the language chosen in the browser.

### Key Entities *(include if feature involves data)*

- **Document**: one file identified by its content hash, shown to the owner by a short sequential number (visible id); attributes: original name (description), sensitivity class (mandatory), detected type (optional), status, attempts, current lease, the accepted extraction (optional), a parent document (reserved for containers), creation time. Statuses: RECEIVED, the pending status of each step, ACCEPTED, NEEDS_REVIEW, REJECTED, FAILED; QUARANTINED is reserved.
- **Page**: one page of a document with its rendered preview image; several pages per document.
- **Page text**: one reading of one page: text, source (text layer or OCR), engine, version, resolution, timings per parser step; append-only.
- **Extraction**: one model call on one document: model identity, schema version, prompt hash, raw request and response, stop reason, token counts and durations, the thresholds in force; append-only.
- **Step run**: one execution of one pipeline step on one document: step name, attempt number, start and end time, duration, outcome; the source of the per-step durations in the detail view and of the parse and model time split in the evaluation; append-only.
- **Field**: one extracted value of one extraction: field name from the registry, typed value, verbatim fragment, page text reference, offsets, found flag, source (model); bounding box reserved.
- **Reason**: a code from the closed list with filled parameters, attached to a document; several per document.
- **Document type schema**: a versioned description of one type's fields, their kinds, which are required, their labels in both interface languages, and the rules checked; the single source for prompts, checks, labels and fixtures. Initial types and field sets (the registry version may refine them):
  - Invoice: number, date, seller name, seller EDRPOU, seller IBAN, buyer name, buyer EDRPOU, currency, total without VAT, VAT amount, total with VAT (all required); VAT rate, payment due date, contract reference, payment purpose (optional).
  - Act of completed works: number, date, contractor name, contractor EDRPOU, customer name, customer EDRPOU, contract reference, service period start, service period end, currency, total without VAT, VAT amount, total with VAT (all required); place of signing (optional).
  - Contract: number, date, first party name, first party EDRPOU, second party name, second party EDRPOU, subject, currency, valid from, valid until (all required); total amount, payment terms, place of signing (optional).
- **Sensitivity class**: `synthetic` or `unverified`, each with a "may leave" rule; the closed list is configuration.
- **Fixture manifest and expected result**: the generator's list of produced files with content hashes, and per file the expected schema instance, status and codes.
- **Thresholds**: the single file of tunable values with their "provisional" marks.
- **Health**: database state, model state (missing or ready), sandbox runtime name, TODO list of named simplifications.
- **Evaluation report**: the figures of one run with the identities of model, schemas and prompt, the thresholds in force and the verdict; printed as text and saved as one JSON file per run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From empty storage, one start command brings the system to "model ready" with no document failed because of start-up order, and a second start with storage kept downloads nothing.
- **SC-002**: One "Read folder" on the eleven fixtures reaches terminal statuses for all of them within the run bound of the thresholds file (provisional estimate: 15 minutes warm on the owner's 8 GB GPU), with exactly 6 ACCEPTED, 4 NEEDS_REVIEW with the expected codes, and zero false accepts.
- **SC-003**: The evaluation's per-field match on the fixtures reaches the pass threshold of the Measurement Contract, and its tokens per document and seconds per page stay under the ceiling written there.
- **SC-004**: Repeating the folder read, regenerating the fixtures and renaming a fixture change the documents count by zero and produce a `DUPLICATE` answer naming the original each time.
- **SC-005**: 100% of documents that are not ACCEPTED show at least one reason with a rendered message; 0 messages are free text from the model.
- **SC-006**: The hostile inputs (5000-page PDF, 30000 x 30000 image, symbolic link, hard link, 1 GB manifest) each end in rejection or a failed job after one attempt, with every other service still running and nothing of them read or served.
- **SC-007**: With the model stopped, the full GPU-free test suite passes; only the contract test and the evaluation need the GPU.
- **SC-008**: From the host, the model port is unreachable, the parser shows only a loopback interface, a non-root user and a read-only root, and the interface answers only on loopback; a request with a foreign Host or Origin is refused and changes nothing.
- **SC-009**: Removing the egress rule of one class, or changing the stored schema version, stops the application at start with a message naming the cause.
- **SC-010**: Adding one type schema file and restarting makes the new type appear in the next classification request; no other file changes.
- **SC-011**: The page header shows every named simplification of the Deferred Simplifications table, and the health view lists the same items.

## Measurement Contract

Written before the first measured run, as the constitution requires (principle I, C14).

- **Metric**: per-field exact match after normalisation, over all fields of the nine typed fixtures, compared with the expected values; false accepts (a field ACCEPTED whose value differs from the expected value) counted separately.
- **Pass threshold** (owner decision of 2026-10-31): 100% exact match on the required fields of the six fixtures expected ACCEPTED, and zero false accepts over all eleven fixtures. One wrong required field, or one accepted value that differs from the expected value, fails the run.
- **Ceiling** (owner decision of 2026-10-31, values provisional until the first run): at most 6,000 tokens per document (prompt and generation together) and at most 60 seconds per page in the warm run, parsing and model time together. The cold run is printed but not judged.
- **Printed by the evaluation**: per-field match; share of each reason code; seconds per page split into parsing and model time, cold and warm separately; tokens per document; false accepts; model identity, schema versions, prompt hash; the line "not a tier decision".
- **Saved by the evaluation**: one JSON report file per run in a results folder, named by run date and model identity, with the same figures, the thresholds in force and the verdict (FR-048a). Report files are kept, never overwritten.
- **Calibration**: the characters-per-token ratio used by the context budget check is calibrated by the evaluation and recorded.

## Re-read Cases

Required by C3. Identity is the content hash; the path is a description.

| Case | Outcome |
| --- | --- |
| A known content hash under any name or path, by folder read or upload | `DUPLICATE` with the original's number; no new document; count unchanged |
| A known path with a new content hash | A new document; the old one is untouched |
| A fixture regenerated by the deterministic generator | Same hashes, therefore `DUPLICATE` for every file |
| A file read again after its document ended REJECTED or FAILED | `DUPLICATE`; the document is not processed again (no retry action in the prototype) |

## Deferred Simplifications

Each item is a named simplification: visible as a start-up warning and in the health TODO list shown in the page header (constitution XII).

| Simplification | Departs from | Undo trigger |
| --- | --- | --- |
| No hardened runtime; the parser runs under the default container runtime | Security baseline (rounds 1-2) | First non-synthetic document, a non-local model connected, or the prototype leaving the dev machine |
| No invisible-text stripping, no `TEXT_LAYER_MISMATCH` | Round 2, decision 4 | First non-synthetic document; the first acceptance check of that work is a fixture with an invisible IBAN |
| No malware scan (`MALWARE` reserved) | Round 1 | First non-synthetic document |
| Model pulled into a volume by tag and verified by digest, not baked into an image | Round 2, decision 12 | First deployment off the dev machine |
| Single in-process worker; boot requeue on top of the lease; no heartbeat | Round 2 queue design | A second worker or replica |
| No migrations; schema version check plus reset | none | First data that cannot be regenerated (hand labels, real documents) |
| No role split, no graceful shutdown drain | none | Kubernetes; the worker module takes its own dependencies, never the web server instance |
| Field bounding box empty | Round 2, decision 7 (nullable) | The reviewer UI |
| No label-proximity rule against substitution | none | The evaluation shows substitutions above the threshold |
| `LOW_CONFIDENCE` and `EXTRACTORS_DISAGREE` not emitted | Closed list | A second extraction attempt or a second extractor |
| No human review form; NEEDS_REVIEW is a dead end | Round 1 | The owner asks for review |
| Database passwords reach the containers as environment variables (visible in `docker inspect`), not as file-backed secrets | OWASP Docker security cheat sheet, rule 12 | The first deployment off the dev machine, or a second user of this machine |

## Out of Scope

- Kubernetes, a human review user interface, a serving API for an external product, embeddings and semantic search, the repair agent, any cloud model, a model download progress screen, an intake log table for duplicates, restarting the parser per job, a file-drop queue between application and parser, a retry action for FAILED documents, real (non-synthetic) documents.

## Assumptions

- Owner decisions recorded in the handoff and confirmed on 2026-10-31 bind the plan and are not re-opened by this specification: the backend in TypeScript on Fastify, the front in React with Vite, the local model served by Ollama (`qwen3.5:4b`) only, everything in Docker Compose with five services plus the one-off fixtures generator, the inbox as a local folder configured by environment with `./inbox` as the default, the hardened runtime deferred but visible, the spec-kit route with Agile Tasks. These are constraints, not requirements; the plan carries their exact versions and digests (constitution XI).
- The repository exists since 2026-10-31 by owner decision, superseding the handoff's "no git for now"; the constitution, the handoff and the agent rules stay untracked.
- The prototype runs on the owner's development machine: Windows 11 with WSL2, Docker Engine inside WSL, one 8 GB GPU; one model fits in memory at a time.
- Only the owner uses the prototype; there is no login and no second user.
- The interface languages are Ukrainian and English (owner decision of 2026-10-31); the documents themselves stay Ukrainian, and the registry carries labels and templates in both languages from the first version.
- All documents are synthetic and in Ukrainian; no personal data exists anywhere in the system (constitution X).
- The three initial types and their field sets in Key Entities are the starting registry; the plan may refine names and kinds, keeping the required sets that the fixtures depend on.
- Every threshold value, and every duration or token figure in this specification, is a provisional estimate until the evaluation measures it (constitution I).
- Documents that contain other documents (archives, mail) are not in the fixture set; the parent attribute is reserved.
- The characters-per-token ratio and the speed figures used to size timeouts are estimates from the handoff; they are used only for sizing and are marked provisional.
