/**
 * Types of the configuration files and of the parser manifest. They mirror the JSON Schemas of
 * specs/001-local-prototype/contracts/ (copied to ./schemas/): the schema is the check at runtime, these types are what
 * the rest of the code reads after a file has passed it. A change to a contract changes both.
 */

/** One row of config/thresholds.json (C13): a tunable value that stays "provisional" until the evaluation measures it. */
export type ThresholdEntry = {
  value: number | string;
  unit: string;
  status: 'provisional' | 'measured';
  source: string;
  measuredAt?: string;
};

/** config/thresholds.json. Keys look like `model.num_ctx`; the schema requires the full list. */
export type ThresholdsFile = {
  version: 1;
  values: Record<string, ThresholdEntry>;
};

/** One sensitivity class (C2). `may_leave` is the egress rule: a class without it stops the application (FR-007). */
export type SensitivityClass = {
  name: string;
  may_leave: boolean;
  description: string;
};

/** config/classes.json: the closed list of sensitivity classes. */
export type ClassesFile = {
  version: 1;
  classes: SensitivityClass[];
};

/** A named parameter of a reason message template. */
export type ReasonParam = {
  name: string;
  kind: 'string' | 'integer' | 'number' | 'date';
};

/** A message template in each interface language, with `{param}` placeholders (FR-058). */
export type ReasonTemplates = {
  uk: string;
  en: string;
};

/** An alternative template picked when every `when` entry equals the stored param of the same name. */
export type ReasonVariant = {
  when: Record<string, string | number | boolean>;
  params: ReasonParam[];
  templates: ReasonTemplates;
};

/** One of the 15 codes of config/reasons.json (FR-024). `code` is narrowed to a closed union by the reasons module. */
export type ReasonEntry = {
  code: string;
  outcome: 'REJECTED' | 'QUARANTINED' | 'NEEDS_REVIEW' | 'RETRY' | 'DUPLICATE';
  emitted: boolean;
  emittedBy: Array<'intake' | 'parse' | 'classify' | 'extract' | 'check' | 'worker'>;
  trigger: string;
  params: ReasonParam[];
  templates: ReasonTemplates;
  variants?: ReasonVariant[];
};

/** config/reasons.json. */
export type ReasonsFile = {
  version: 1;
  reasons: ReasonEntry[];
};

/** config/model.json: the model tag and the digest pinned after the first pull (research R2). Empty until pinned. */
export type ModelConfig = {
  tag: string;
  digest: string;
};

/** One page entry of the parser manifest (contracts/parser-manifest.schema.json). */
export type ParserManifestPage = {
  n: number;
  source: 'text_layer' | 'ocr';
  engine: string;
  engineVersion: string;
  dpi: number | null;
  widthPx: number;
  heightPx: number;
  ocrWordsTotal: number | null;
  ocrWordsLow: number | null;
  timingsMs: { render: number; text: number; ocr: number };
};

/** The manifest the parser writes last in a job folder; the app validates it before trusting anything (FR-014). */
export type ParserManifest = {
  version: 1;
  jobId: string;
  detectedMime: string;
  converter: string | null;
  pageCount: number;
  pages: ParserManifestPage[];
  timingsMs: { detect: number; convert: number; pdfinfo: number; total: number };
  limitsHit: string[];
};
