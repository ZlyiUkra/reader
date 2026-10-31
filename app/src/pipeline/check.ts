import type { ValidateFunction } from 'ajv/dist/2020.js';
import type pg from 'pg';
import { createAjv } from '../config/ajv.ts';
import { finishStep } from '../db/claim.ts';
import { insertField, insertReason, latestExtractionOf, markChecksDone, pageReadingsOf, setAcceptedExtraction } from '../db/queries.ts';
import { withTransaction } from '../db/tx.ts';
import { terminalStatuses, stepStatuses } from '../reasons/status.ts';
import type { ReasonCode } from '../reasons/reasons.ts';
import type { Registry, RegistryType } from '../registry/registry.ts';
import { isEdrpou, isUaIban } from '../shared/checksums.ts';
import type { Logger } from '../shared/logger.ts';
import { vatSumHolds } from '../shared/values.ts';
import type { StepHandler } from '../worker.ts';
import { gatherEvidence, quotesOf, storedReply } from './evidence.ts';
import type { FieldEvidence } from './evidence.ts';
import { ModelReplyError } from './model-call.ts';

/**
 * The check step (FR-021, FR-026, constitution VI): the stored reply of the model is turned into evidence, the evidence is
 * written as the `fields` rows, and the rules of the registry are run on the typed values. Every rule that fails leaves a
 * reason; no reasons and the checks done is what makes the status function say ACCEPTED. Fields, reasons, `checks_done`,
 * the accepted extraction and the new status commit in one transaction (FR-030). Nothing here calls the model or the
 * network, and the rules are exact: a tolerance that lets the wrong-VAT invoice pass is a defect (C11).
 */

/** A reason found by the step: a code and its named parameters, before it is written for the attempt. */
export type FoundReason = {
  code: ReasonCode;
  params: Record<string, string | number>;
};

/** An amount of kopiyky written as a decimal string with two places, with integer arithmetic only: 1200050 is "12000.50". */
export function formatKopiyky(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** The typed value of a field that has one, or undefined: a field with no evidence takes no part in a rule. */
function canonicalOf(evidence: Map<string, FieldEvidence>, name: string): string | number | undefined {
  const entry = evidence.get(name);
  return entry?.state === 'ok' ? entry.value?.canonical : undefined;
}

/**
 * The reasons of one document: first what each field's evidence says (a required field the model did not find, a quoted
 * fragment that is not in the text, a fragment that is not a value of the field), then the rules of the type in the order
 * the registry lists them. A rule whose fields are missing is skipped, because those fields already carry their own reason
 * when they are required, and an optional field that is absent breaks nothing.
 */
export function reasonsOfEvidence(type: RegistryType, evidence: FieldEvidence[]): FoundReason[] {
  const found: FoundReason[] = [];
  const byName = new Map(evidence.map((entry) => [entry.name, entry]));
  for (const entry of evidence) {
    const required = type.fields.find((field) => field.name === entry.name)?.required ?? false;
    if (entry.state === 'absent' && required) {
      found.push({ code: 'MISSING_REQUIRED_FIELD', params: { field: entry.name } });
    } else if (entry.state === 'not-located') {
      // 0 stands for "the model named no page": the template still reads, and nothing is invented.
      found.push({ code: 'VALIDATION_FAILED', params: { field: entry.name, fragment: entry.verbatim ?? '', page: entry.claimedPage ?? 0 } });
    } else if (entry.state === 'unreadable') {
      found.push({ code: 'VALIDATION_FAILED', params: { check: 'value', field: entry.name, fragment: entry.verbatim ?? '' } });
    }
  }
  for (const check of type.checks) {
    switch (check.rule) {
      case 'vat_sum': {
        const net = canonicalOf(byName, check.net);
        const vat = canonicalOf(byName, check.vat);
        const gross = canonicalOf(byName, check.gross);
        if (typeof net === 'number' && typeof vat === 'number' && typeof gross === 'number' && !vatSumHolds(net, vat, gross, check.rate)) {
          found.push({ code: 'VALIDATION_FAILED', params: { check: 'vat_sum', net: formatKopiyky(net), vat: formatKopiyky(vat), gross: formatKopiyky(gross), rate: check.rate } });
        }
        break;
      }
      case 'date_order': {
        const earlier = canonicalOf(byName, check.earlier);
        const later = canonicalOf(byName, check.later);
        // ISO dates compare as text: the order of the strings is the order of the days.
        if (typeof earlier === 'string' && typeof later === 'string' && earlier > later) {
          found.push({ code: 'VALIDATION_FAILED', params: { check: 'date_order', earlier, later } });
        }
        break;
      }
      case 'edrpou': {
        const code = canonicalOf(byName, check.field);
        if (typeof code === 'string' && !isEdrpou(code)) {
          found.push({ code: 'VALIDATION_FAILED', params: { check: 'edrpou', field: check.field } });
        }
        break;
      }
      case 'iban_ua': {
        const iban = canonicalOf(byName, check.field);
        if (typeof iban === 'string' && !isUaIban(iban)) {
          found.push({ code: 'VALIDATION_FAILED', params: { check: 'iban_ua', field: check.field } });
        }
        break;
      }
    }
  }
  return found;
}

/** What the check step is built from. */
export type CheckStepDeps = {
  pool: pg.Pool;
  registry: Registry;
  logger: Logger;
};

/**
 * One validator per type, over the canonical schema with `required` emptied: it checks the type, the pattern, the format
 * and the enumeration of the values that exist, while a field that is missing is the business rule of `required`, which has
 * its own reason (FR-040, C10). The copy has no `$id`, so compiling it next to the registry's own schema is allowed.
 */
function valueValidators(registry: Registry): Map<string, ValidateFunction> {
  const ajv = createAjv();
  return new Map(
    registry.types.map((type) => {
      const { $id: _id, ...rest } = type.schema;
      return [type.name, ajv.compile({ ...rest, required: [] })];
    }),
  );
}

/** Builds the handler of the check step. */
export function createCheckStep(deps: CheckStepDeps): StepHandler {
  const validators = valueValidators(deps.registry);

  return async (claimed) => {
    const { document } = claimed;
    const type = document.doc_type === null ? undefined : deps.registry.byName.get(document.doc_type);
    const validate = type === undefined ? undefined : validators.get(type.name);
    if (type === undefined || validate === undefined) {
      throw new ModelReplyError(`Document ${document.id} reached the check step with the type "${document.doc_type ?? ''}", which is not in the registry.`);
    }
    const extraction = await latestExtractionOf(deps.pool, document.id, 'extract');
    if (extraction === null) {
      throw new ModelReplyError(`Document ${document.id} reached the check step without an extraction.`);
    }
    const readings = await pageReadingsOf(deps.pool, document.id);
    const evidence = gatherEvidence(type, quotesOf(type, storedReply(extraction)), readings);

    const instance = Object.fromEntries(evidence.flatMap((entry) => (entry.state === 'ok' && entry.value !== null ? [[entry.name, entry.value.canonical]] : [])));
    if (!validate(instance)) {
      throw new ModelReplyError(`The derived values of document ${document.id} do not satisfy the schema ${type.schemaId}: ${JSON.stringify(validate.errors)}`);
    }
    const reasons = reasonsOfEvidence(type, evidence);

    const status = await withTransaction(deps.pool, async (client) => {
      for (const entry of evidence) {
        await insertField(client, {
          extractionId: extraction.id,
          documentId: document.id,
          name: entry.name,
          kind: entry.kind,
          value: entry.value?.stored ?? null,
          verbatim: entry.verbatim,
          pageTextId: entry.located?.pageTextId ?? null,
          offsetStart: entry.located?.start ?? null,
          offsetEnd: entry.located?.end ?? null,
          source: 'model',
        });
      }
      for (const reason of reasons) {
        await insertReason(client, { documentId: document.id, code: reason.code, params: reason.params, step: claimed.step, attempt: claimed.attempt });
      }
      await markChecksDone(client, document.id);
      const settled = await finishStep(client, {
        documentId: document.id,
        stepRunId: claimed.stepRunId,
        step: claimed.step,
        outcome: reasons.length > 0 ? 'reason' : 'ok',
        details: { extractionId: extraction.id, fields: evidence.length, reasons: reasons.map((reason) => reason.code) },
        statusWhenOpen: stepStatuses.CHECK,
      });
      if (settled === terminalStatuses.ACCEPTED) {
        await setAcceptedExtraction(client, document.id, extraction.id);
      }
      return settled;
    });
    deps.logger.info({ document: document.id, attempt: claimed.attempt, type: type.name, status, reasons: reasons.map((reason) => reason.code) }, 'The check step finished.');
  };
}
