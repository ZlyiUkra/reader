-- Tables of specs/001-local-prototype/data-model.md. Runs once, as the superuser, so the application role owns nothing.
-- Conventions: bigint identity keys, timestamptz for every time, money as bigint kopiyky, jsonb for JSON,
-- no ON DELETE CASCADE anywhere (nothing is deleted). The closed lists (statuses, classes, kinds, reason codes) live in
-- code and configuration files, not in CHECK constraints, so there is one source for each (constitution II).
-- A change to this file means `docker compose down -v` (FR-034, named simplification: no migrations).

CREATE TABLE schema_version (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version (version) VALUES (1);

-- The status table (constitution III): the only record of where a document is.
CREATE TABLE documents (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256                 char(64) NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name          text,
  original_path          text,
  size_bytes             bigint NOT NULL,
  detected_mime          text,
  class                  text NOT NULL,
  doc_type               text,
  schema_id              text,
  status                 text NOT NULL,
  attempts               integer NOT NULL DEFAULT 0,
  checks_done            boolean NOT NULL DEFAULT false,
  locked_until           timestamptz,
  locked_by              text,
  accepted_extraction_id bigint,
  parent_id              bigint REFERENCES documents (id),
  blob_key               text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_claim_idx ON documents (status, locked_until);

CREATE TABLE step_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents (id),
  step        text NOT NULL,
  attempt     integer NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  outcome     text,
  details     jsonb
);
CREATE INDEX step_runs_document_idx ON step_runs (document_id);

CREATE TABLE pages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES documents (id),
  page_no      integer NOT NULL,
  width_px     integer NOT NULL,
  height_px    integer NOT NULL,
  png_blob_key text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_no)
);

CREATE TABLE page_texts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id         bigint NOT NULL REFERENCES pages (id),
  source          text NOT NULL,
  engine          text NOT NULL,
  engine_version  text NOT NULL,
  dpi             integer,
  text            text NOT NULL,
  ocr_words_total integer,
  ocr_words_low   integer,
  timings         jsonb NOT NULL,
  thresholds      jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_texts_page_idx ON page_texts (page_id);

CREATE TABLE extractions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id             bigint NOT NULL REFERENCES documents (id),
  kind                    text NOT NULL,
  attempt                 integer NOT NULL,
  adapter                 text NOT NULL,
  model_name              text NOT NULL,
  model_digest            text NOT NULL,
  schema_id               text,
  registry_hash           text NOT NULL,
  prompt_hash             text NOT NULL,
  wire_schema_hash        text NOT NULL,
  raw_request             jsonb NOT NULL,
  raw_response            jsonb NOT NULL,
  done_reason             text,
  load_duration_ns        bigint,
  prompt_eval_count       integer,
  prompt_eval_duration_ns bigint,
  eval_count              integer,
  eval_duration_ns        bigint,
  total_duration_ns       bigint,
  cold                    boolean NOT NULL,
  thresholds              jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extractions_document_idx ON extractions (document_id);

-- Closes the circle documents -> extractions that could not be declared when documents was created.
ALTER TABLE documents ADD CONSTRAINT documents_accepted_extraction_fk
  FOREIGN KEY (accepted_extraction_id) REFERENCES extractions (id);

-- The typed value is computed by the pipeline from the located fragment; the model's own value stays in
-- extractions.raw_response (constitution V). `found` follows from the offsets and cannot be set by hand.
CREATE TABLE fields (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extraction_id bigint NOT NULL REFERENCES extractions (id),
  document_id   bigint NOT NULL REFERENCES documents (id),
  name          text NOT NULL,
  kind          text NOT NULL,
  value         jsonb,
  verbatim      text,
  page_text_id  bigint REFERENCES page_texts (id),
  offset_start  integer,
  offset_end    integer,
  found         boolean GENERATED ALWAYS AS (offset_start IS NOT NULL) STORED,
  source        text NOT NULL,
  bbox          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fields_document_idx ON fields (document_id);
CREATE INDEX fields_extraction_idx ON fields (extraction_id);

-- Messages are never stored: they are rendered from the reasons file template at display time (C1, FR-025).
CREATE TABLE reasons (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents (id),
  code        text NOT NULL,
  params      jsonb NOT NULL,
  step        text NOT NULL,
  attempt     integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reasons_document_idx ON reasons (document_id);

-- Privileges of the application role (constitution III, append-only data enforced by the database itself):
-- every table is insert-only for the application except `documents`, where only the columns the pipeline moves
-- are updatable. detected_mime, doc_type and schema_id are set once, after intake, by the parse and classify steps.
GRANT SELECT ON schema_version, documents, step_runs, pages, page_texts, extractions, fields, reasons TO app;
GRANT INSERT ON documents, step_runs, pages, page_texts, extractions, fields, reasons TO app;
GRANT UPDATE (detected_mime, doc_type, schema_id, status, attempts, checks_done, locked_until, locked_by,
              accepted_extraction_id, updated_at) ON documents TO app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app;
