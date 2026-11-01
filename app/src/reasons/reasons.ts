import type { ReasonEntry, ReasonsFile, ReasonTemplates } from '../config/types.ts';
import { placeholders } from '../shared/format.ts';
import type { FormatParams } from '../shared/format.ts';
import { renderReason } from '../shared/reason-text.ts';

/**
 * The closed list of reason codes, each with the outcome the status function gives it (FR-024, FR-026, C1), in the
 * order of the specification. It is a plain object, not an `enum` (type stripping, C16): the keys are the codes and the
 * values are the outcomes, so `status()` and the start-up check below read one table. `config/reasons.json` declares
 * the same codes and outcomes with their texts; `createReasons` refuses a file that disagrees with this table.
 */
export const reasonCodes = {
  ENCRYPTED: 'REJECTED',
  CORRUPT: 'REJECTED',
  MALWARE: 'QUARANTINED',
  TOO_LARGE: 'REJECTED',
  UNSUPPORTED_FORMAT: 'REJECTED',
  DUPLICATE: 'DUPLICATE',
  LOW_OCR_QUALITY: 'NEEDS_REVIEW',
  UNKNOWN_DOC_TYPE: 'NEEDS_REVIEW',
  MISSING_REQUIRED_FIELD: 'NEEDS_REVIEW',
  VALIDATION_FAILED: 'NEEDS_REVIEW',
  LOW_CONFIDENCE: 'NEEDS_REVIEW',
  EMPTY: 'NEEDS_REVIEW',
  INTERNAL_ERROR: 'RETRY',
  EXTRACTORS_DISAGREE: 'NEEDS_REVIEW',
  TEXT_LAYER_MISMATCH: 'NEEDS_REVIEW',
} as const;

/** One of the 15 reason codes. */
export type ReasonCode = keyof typeof reasonCodes;

/** The outcome a code leads to; the five values of `reasons.schema.json`. */
export type ReasonOutcome = (typeof reasonCodes)[ReasonCode];

/** Narrows a string that came from outside the code (a database row, a request) to the closed list of codes. */
export function isReasonCode(value: string): value is ReasonCode {
  return Object.hasOwn(reasonCodes, value);
}

/** The outcome of a code; a code outside the list is a defect of the caller and stops here instead of being ignored. */
export function outcomeOf(code: string): ReasonOutcome {
  if (!isReasonCode(code)) {
    throw new ReasonsError(`Unknown reason code ${code}`);
  }
  return reasonCodes[code];
}

/** The stored parameters of one reason (data-model.md, `reasons.params`). */
export type ReasonParams = FormatParams;

/** The interface languages a template exists in (FR-058). */
export type TemplateLang = keyof ReasonTemplates;

/**
 * A reasons file that cannot be used: it disagrees with the closed list of codes or names a parameter its entry does not
 * declare. Like a `ConfigError`, it is a refusal to start that names the cause, so the owner knows what to fix.
 */
export class ReasonsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReasonsError';
  }
}

/** The reasons file turned into what the pipeline and the API use: the entries as read, and the renderer of messages. */
export type Reasons = {
  entries: ReasonEntry[];
  render: (code: ReasonCode, params: ReasonParams, lang: TemplateLang) => string;
};

/**
 * Checks that the templates of one entry or variant agree: both languages name the same placeholders (FR-058) and every
 * placeholder is a declared parameter. A typo here would otherwise show up as `{fildName}` in a message weeks later.
 */
function assertTemplates(where: string, templates: ReasonTemplates, declared: string[]): void {
  const uk = new Set(placeholders(templates.uk));
  const en = new Set(placeholders(templates.en));
  for (const name of new Set([...uk, ...en])) {
    if (!uk.has(name) || !en.has(name)) {
      throw new ReasonsError(`${where}: the placeholder {${name}} is not in both the Ukrainian and the English template.`);
    }
    if (!declared.includes(name)) {
      throw new ReasonsError(`${where}: the placeholder {${name}} is not a declared parameter.`);
    }
  }
}

/**
 * Validates a reasons file that already passed its JSON Schema against the closed list of this module, and builds the
 * renderer. The file must declare exactly the 15 codes, each with the outcome of the table above and each template
 * naming only declared parameters; anything else is a `ReasonsError`. Rows store `{code, params}` and the message is
 * rendered here from the template, never written by a model (FR-025).
 */
export function createReasons(file: ReasonsFile): Reasons {
  const byCode = new Map<string, ReasonEntry>();
  for (const entry of file.reasons) {
    if (!isReasonCode(entry.code)) {
      throw new ReasonsError(`The reasons file declares ${entry.code}, which is not one of the 15 codes.`);
    }
    if (entry.outcome !== reasonCodes[entry.code]) {
      throw new ReasonsError(`The reasons file gives ${entry.code} the outcome ${entry.outcome}; the status rules expect ${reasonCodes[entry.code]}.`);
    }
    assertTemplates(entry.code, entry.templates, entry.params.map((param) => param.name));
    for (const variant of entry.variants ?? []) {
      const declared = variant.params.map((param) => param.name);
      for (const name of Object.keys(variant.when)) {
        if (!declared.includes(name)) {
          throw new ReasonsError(`${entry.code}: a variant is chosen by ${name}, which it does not declare as a parameter.`);
        }
      }
      assertTemplates(`${entry.code} variant`, variant.templates, declared);
    }
    byCode.set(entry.code, entry);
  }
  const missing = Object.keys(reasonCodes).filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new ReasonsError(`The reasons file does not declare: ${missing.join(', ')}.`);
  }

  function render(code: ReasonCode, params: ReasonParams, lang: TemplateLang): string {
    const entry = byCode.get(code);
    if (entry === undefined) {
      throw new ReasonsError(`Unknown reason code ${code}`);
    }
    return renderReason(entry, params, lang);
  }

  return { entries: file.reasons, render };
}
