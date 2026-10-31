import type { Queryable } from './tx.ts';

/**
 * Every statement the pipeline sends to PostgreSQL (FR-030, FR-035). All of them are parameterised and name their tables
 * and columns in the text: identifiers never come from input, the registry or a request. Rows are only ever added, with
 * the two departures the data model names: the status columns of `documents` move, and a `step_runs` row is completed
 * once. A helper that changes a row says so in its name (`complete…`, `set…`).
 */

/** A row of `documents`, the status table (data-model.md). The visible number of a document is its `id`. */
export type DocumentRow = {
  id: number;
  sha256: string;
  original_name: string | null;
  original_path: string | null;
  size_bytes: number;
  detected_mime: string | null;
  class: string;
  doc_type: string | null;
  schema_id: string | null;
  status: string;
  attempts: number;
  checks_done: boolean;
  locked_until: Date | null;
  locked_by: string | null;
  accepted_extraction_id: number | null;
  parent_id: number | null;
  blob_key: string;
  created_at: Date;
  updated_at: Date;
};

/** What intake knows about a new document. The status is always `RECEIVED` and the number is assigned by the database. */
export type NewDocument = {
  sha256: string;
  originalName: string | null;
  originalPath: string | null;
  sizeBytes: number;
  documentClass: string;
  blobKey: string;
};

/** Adds a document in `RECEIVED`. Returns its number, or `null` when the hash was inserted by someone else meanwhile. */
export async function insertDocument(db: Queryable, document: NewDocument): Promise<number | null> {
  const result = await db.query<{ id: number }>(
    `INSERT INTO documents (sha256, original_name, original_path, size_bytes, class, status, blob_key)
     VALUES ($1, $2, $3, $4, $5, 'RECEIVED', $6)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING id`,
    [document.sha256, document.originalName, document.originalPath, document.sizeBytes, document.documentClass, document.blobKey],
  );
  return result.rows[0]?.id ?? null;
}

/** The document with this content hash, if it is known: identity is the hash (FR-002). */
export async function documentBySha256(db: Queryable, sha256: string): Promise<DocumentRow | null> {
  const result = await db.query<DocumentRow>('SELECT * FROM documents WHERE sha256 = $1', [sha256]);
  return result.rows[0] ?? null;
}

/** The document with this visible number, if there is one. */
export async function documentByNumber(db: Queryable, number: number): Promise<DocumentRow | null> {
  const result = await db.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [number]);
  return result.rows[0] ?? null;
}

/** The newest documents first, at most `limit` of them (`GET /documents`). */
export async function listDocuments(db: Queryable, limit: number): Promise<DocumentRow[]> {
  const result = await db.query<DocumentRow>('SELECT * FROM documents ORDER BY id DESC LIMIT $1', [limit]);
  return result.rows;
}

/** The number of documents. A repeated read of the same files must leave it unchanged (FR-003, check 5). */
export async function countDocuments(db: Queryable): Promise<number> {
  const result = await db.query<{ count: number }>('SELECT count(*) AS count FROM documents');
  return result.rows[0]?.count ?? 0;
}

/** Records the format the parser found from the content. It moves from null to its value once, in the parse step. */
export async function setDetectedMime(db: Queryable, documentId: number, mime: string): Promise<void> {
  await db.query('UPDATE documents SET detected_mime = $2, updated_at = now() WHERE id = $1 AND detected_mime IS NULL', [documentId, mime]);
}

/** A rendered page of a document, with its preview stored under `pngBlobKey`. */
export type NewPage = {
  documentId: number;
  pageNo: number;
  widthPx: number;
  heightPx: number;
  pngBlobKey: string;
};

/** Adds a page and returns its id. A second page with the same number for the document is refused by the database. */
export async function insertPage(db: Queryable, page: NewPage): Promise<number> {
  const result = await db.query<{ id: number }>(
    'INSERT INTO pages (document_id, page_no, width_px, height_px, png_blob_key) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [page.documentId, page.pageNo, page.widthPx, page.heightPx, page.pngBlobKey],
  );
  return result.rows[0]?.id ?? failed('insert a page');
}

/** One reading of a page, with the numbers that were in force and the parser's timings (FR-032). */
export type NewPageText = {
  pageId: number;
  source: 'text_layer' | 'ocr';
  engine: string;
  engineVersion: string;
  dpi: number | null;
  text: string;
  ocrWordsTotal: number | null;
  ocrWordsLow: number | null;
  timings: object;
  thresholds: object;
};

/** Adds a page reading and returns its id. */
export async function insertPageText(db: Queryable, reading: NewPageText): Promise<number> {
  const result = await db.query<{ id: number }>(
    `INSERT INTO page_texts (page_id, source, engine, engine_version, dpi, text, ocr_words_total, ocr_words_low, timings, thresholds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
     RETURNING id`,
    [reading.pageId, reading.source, reading.engine, reading.engineVersion, reading.dpi, reading.text, reading.ocrWordsTotal, reading.ocrWordsLow, JSON.stringify(reading.timings), JSON.stringify(reading.thresholds)],
  );
  return result.rows[0]?.id ?? failed('insert a page text');
}

/** One reading of a page as the model steps use it: the page number, the reading's id and its stored text. */
export type PageReading = {
  pageNo: number;
  pageTextId: number;
  text: string;
};

/**
 * The text of every page of a document in page order, one reading per page (the first one stored: the prototype reads each
 * page once, constitution V). The model steps build their prompts from these and the evidence step searches them, so both
 * work on the same stored text and the offsets they compute refer to it.
 */
export async function pageReadingsOf(db: Queryable, documentId: number): Promise<PageReading[]> {
  const result = await db.query<{ page_no: number; id: number; text: string }>(
    `SELECT DISTINCT ON (p.page_no) p.page_no, t.id, t.text
     FROM pages p JOIN page_texts t ON t.page_id = p.id
     WHERE p.document_id = $1
     ORDER BY p.page_no, t.id`,
    [documentId],
  );
  return result.rows.map((row) => ({ pageNo: row.page_no, pageTextId: row.id, text: row.text }));
}

/** Records the registry type the classifier chose and the schema version it was read with. It moves from null once, in the classify step. */
export async function setDocType(db: Queryable, documentId: number, docType: string, schemaId: string): Promise<void> {
  await db.query('UPDATE documents SET doc_type = $2, schema_id = $3, updated_at = now() WHERE id = $1 AND doc_type IS NULL', [documentId, docType, schemaId]);
}

/** Records that the checks ran, which is what lets the status function say ACCEPTED when no reason was found (FR-026). */
export async function markChecksDone(db: Queryable, documentId: number): Promise<void> {
  await db.query('UPDATE documents SET checks_done = true, updated_at = now() WHERE id = $1', [documentId]);
}

/** Points an accepted document at the extraction whose fields were accepted. */
export async function setAcceptedExtraction(db: Queryable, documentId: number, extractionId: number): Promise<void> {
  await db.query('UPDATE documents SET accepted_extraction_id = $2, updated_at = now() WHERE id = $1', [documentId, extractionId]);
}

/** A reason as stored: a code and its named parameters, never a message (FR-025). */
export type NewReason = {
  documentId: number;
  code: string;
  params: object;
  step: string;
  attempt: number;
};

/** A stored reason. */
export type ReasonRow = {
  id: number;
  document_id: number;
  code: string;
  params: Record<string, string | number>;
  step: string;
  attempt: number;
  created_at: Date;
};

/** Adds a reason to a document. */
export async function insertReason(db: Queryable, reason: NewReason): Promise<void> {
  await db.query('INSERT INTO reasons (document_id, code, params, step, attempt) VALUES ($1, $2, $3::jsonb, $4, $5)', [
    reason.documentId,
    reason.code,
    JSON.stringify(reason.params),
    reason.step,
    reason.attempt,
  ]);
}

/** The reasons of a document, oldest first. */
export async function reasonsOf(db: Queryable, documentId: number): Promise<ReasonRow[]> {
  const result = await db.query<ReasonRow>('SELECT * FROM reasons WHERE document_id = $1 ORDER BY id', [documentId]);
  return result.rows;
}

/** A row of `step_runs`: one attempt of one step on one document. */
export type StepRunRow = {
  id: number;
  document_id: number;
  step: string;
  attempt: number;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  details: Record<string, unknown> | null;
};

/** Starts the record of an attempt. The claim does this in its own transaction; `finished_at` stays null until the end. */
export async function insertStepRun(db: Queryable, documentId: number, step: string, attempt: number): Promise<number> {
  const result = await db.query<{ id: number }>('INSERT INTO step_runs (document_id, step, attempt, started_at) VALUES ($1, $2, $3, now()) RETURNING id', [
    documentId,
    step,
    attempt,
  ]);
  return result.rows[0]?.id ?? failed('insert a step run');
}

/**
 * Completes an attempt once: `finished_at`, `outcome` and `details` are set on a row whose `finished_at` is still null (the
 * named departure from append-only, data-model.md). Returns false when the row was already completed, which means the
 * lease expired and another path recorded the end of this attempt: the caller must not commit its output.
 */
export async function completeStepRun(db: Queryable, stepRunId: number, outcome: string, details: object): Promise<boolean> {
  const result = await db.query('UPDATE step_runs SET finished_at = now(), outcome = $2, details = $3::jsonb WHERE id = $1 AND finished_at IS NULL', [
    stepRunId,
    outcome,
    JSON.stringify(details),
  ]);
  return result.rowCount === 1;
}

/** The attempts of a document, oldest first (the detail view reads the durations from here). */
export async function stepRunsOf(db: Queryable, documentId: number): Promise<StepRunRow[]> {
  const result = await db.query<StepRunRow>('SELECT * FROM step_runs WHERE document_id = $1 ORDER BY id', [documentId]);
  return result.rows;
}

/** One model call on one document (data-model.md, `extractions`). */
export type NewExtraction = {
  documentId: number;
  kind: 'classify' | 'extract';
  attempt: number;
  adapter: string;
  modelName: string;
  modelDigest: string;
  schemaId: string | null;
  registryHash: string;
  promptHash: string;
  wireSchemaHash: string;
  rawRequest: object;
  rawResponse: object;
  doneReason: string | null;
  loadDurationNs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationNs: number | null;
  evalCount: number | null;
  evalDurationNs: number | null;
  totalDurationNs: number | null;
  cold: boolean;
  thresholds: object;
};

/** Adds a model call and returns its id. */
export async function insertExtraction(db: Queryable, extraction: NewExtraction): Promise<number> {
  const result = await db.query<{ id: number }>(
    `INSERT INTO extractions (document_id, kind, attempt, adapter, model_name, model_digest, schema_id, registry_hash, prompt_hash,
       wire_schema_hash, raw_request, raw_response, done_reason, load_duration_ns, prompt_eval_count, prompt_eval_duration_ns,
       eval_count, eval_duration_ns, total_duration_ns, cold, thresholds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
     RETURNING id`,
    [
      extraction.documentId,
      extraction.kind,
      extraction.attempt,
      extraction.adapter,
      extraction.modelName,
      extraction.modelDigest,
      extraction.schemaId,
      extraction.registryHash,
      extraction.promptHash,
      extraction.wireSchemaHash,
      JSON.stringify(extraction.rawRequest),
      JSON.stringify(extraction.rawResponse),
      extraction.doneReason,
      extraction.loadDurationNs,
      extraction.promptEvalCount,
      extraction.promptEvalDurationNs,
      extraction.evalCount,
      extraction.evalDurationNs,
      extraction.totalDurationNs,
      extraction.cold,
      JSON.stringify(extraction.thresholds),
    ],
  );
  return result.rows[0]?.id ?? failed('insert an extraction');
}

/** A stored model call, as far as the pipeline reads it back: which one it was and exactly what the model answered. */
export type ExtractionRow = {
  id: number;
  document_id: number;
  kind: 'classify' | 'extract';
  attempt: number;
  adapter: string;
  schema_id: string | null;
  raw_request: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  done_reason: string | null;
  cold: boolean;
};

/** The newest model call of a kind on a document, or null. A retried step adds a new row, so the newest is the one that finished the step. */
export async function latestExtractionOf(db: Queryable, documentId: number, kind: 'classify' | 'extract'): Promise<ExtractionRow | null> {
  const result = await db.query<ExtractionRow>(
    `SELECT id, document_id, kind, attempt, adapter, schema_id, raw_request, raw_response, done_reason, cold
     FROM extractions WHERE document_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
    [documentId, kind],
  );
  return result.rows[0] ?? null;
}

/** A stored field with its evidence. */
export type FieldRow = {
  id: number;
  extraction_id: number;
  document_id: number;
  name: string;
  kind: string;
  value: unknown;
  verbatim: string | null;
  page_text_id: number | null;
  offset_start: number | null;
  offset_end: number | null;
  found: boolean;
  source: string;
};

/** The fields of one extraction in the order they were written. */
export async function fieldsOfExtraction(db: Queryable, extractionId: number): Promise<FieldRow[]> {
  const result = await db.query<FieldRow>(
    'SELECT id, extraction_id, document_id, name, kind, value, verbatim, page_text_id, offset_start, offset_end, found, source FROM fields WHERE extraction_id = $1 ORDER BY id',
    [extractionId],
  );
  return result.rows;
}

/** One extracted field with its evidence: `found` is computed by the database from the offsets. */
export type NewField = {
  extractionId: number;
  documentId: number;
  name: string;
  kind: string;
  value: unknown;
  verbatim: string | null;
  pageTextId: number | null;
  offsetStart: number | null;
  offsetEnd: number | null;
  source: string;
};

/** Adds a field of an extraction. */
export async function insertField(db: Queryable, field: NewField): Promise<void> {
  await db.query(
    `INSERT INTO fields (extraction_id, document_id, name, kind, value, verbatim, page_text_id, offset_start, offset_end, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
    [
      field.extractionId,
      field.documentId,
      field.name,
      field.kind,
      field.value === undefined || field.value === null ? null : JSON.stringify(field.value),
      field.verbatim,
      field.pageTextId,
      field.offsetStart,
      field.offsetEnd,
      field.source,
    ],
  );
}

/** An insert that returned no row cannot happen on a healthy database, so it stops here with the name of what failed. */
function failed(what: string): never {
  throw new Error(`The database did not return a row when asked to ${what}`);
}
