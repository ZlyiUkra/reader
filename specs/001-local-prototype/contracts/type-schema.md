# Contract: document type schemas and what derives from them

One file per type version in `schemas/`, JSON Schema draft 2020-12, loaded and compiled by ajv at start
(constitution II, C10). The registry is the single source of the classification list, the prompt, the wire
schema, the checks, the field labels and order, and the fixtures' expected values.

## File shape

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://reader.local/schemas/invoice.v1.json",
  "title": "invoice",
  "type": "object",
  "additionalProperties": false,
  "required": ["number", "date", "sellerName", "sellerEdrpou", "sellerIban", "buyerName", "buyerEdrpou",
               "currency", "totalNet", "vat", "totalGross"],
  "properties": {
    "number":      { "type": "string", "x-reader": { "kind": "string", "labels": { "uk": "Номер", "en": "Number" } } },
    "date":        { "type": "string", "format": "date", "x-reader": { "kind": "date", "labels": { "uk": "Дата", "en": "Date" } } },
    "sellerEdrpou":{ "type": "string", "pattern": "^[0-9]{8}$", "x-reader": { "kind": "edrpou", "labels": { "uk": "ЄДРПОУ продавця", "en": "Seller EDRPOU" } } },
    "sellerIban":  { "type": "string", "pattern": "^UA[0-9]{27}$", "x-reader": { "kind": "iban", "labels": { "uk": "IBAN продавця", "en": "Seller IBAN" } } },
    "currency":    { "type": "string", "enum": ["UAH"], "x-reader": { "kind": "enum", "labels": { "uk": "Валюта", "en": "Currency" } } },
    "totalNet":    { "type": "integer", "x-reader": { "kind": "money", "labels": { "uk": "Сума без ПДВ", "en": "Total without VAT" } } }
  },
  "x-reader": {
    "labels": { "uk": "Рахунок", "en": "Invoice" },
    "order": ["number", "date", "sellerName", "..."],
    "checks": [
      { "rule": "vat_sum", "net": "totalNet", "vat": "vat", "gross": "totalGross", "rate": 20 },
      { "rule": "date_order", "earlier": "date", "later": "dueDate" },
      { "rule": "edrpou", "field": "sellerEdrpou" }, { "rule": "edrpou", "field": "buyerEdrpou" },
      { "rule": "iban_ua", "field": "sellerIban" }
    ]
  }
}
```

Rules:

- Only the subset every adapter accepts in the canonical schema: `type`, `enum`, `required`, `properties`,
  `additionalProperties`, `format: date`, `pattern`. No `$ref`, no `oneOf`, no `minimum`, no `maxLength`; a
  constraint that is not in this subset becomes a check (C10).
- `kind` is one of `string`, `date`, `money`, `enum`, `edrpou`, `iban`. Money fields are `integer` kopiyky in the
  canonical schema and in `expected`; the model is asked for the verbatim text and the pipeline normalises (C11).
- Labels exist in both languages for the type and for every field (FR-058); a test asserts it for every file.
- `x-reader.order` lists every property once; the front shows fields in this order.

## Wire schema (what the model receives)

A pure function `wireSchema(canonical)`, snapshot-tested per type (acceptance check 9):

- Every `x-` key removed.
- Every property becomes `{ "type": "object", "required": ["verbatim", "page"], "additionalProperties": false,
  "properties": { "verbatim": { "type": ["string", "null"] }, "page": { "type": ["integer", "null"] } } }`: the
  model returns the quoted fragment and its page, or `null` for both when the field is absent on the document.
- All properties are `required` at the wire level, so every field is present with an explicit absent path; the
  business `required` of the canonical schema is checked by the pipeline, not by the model.
- `format`, `pattern`, `enum` are dropped from the wire schema: the value is derived from the fragment and checked
  by the pipeline.

## Classification request

Derived from the registry: the enum of type names plus `none`, in registry order. Wire schema:
`{ "type": "object", "required": ["type"], "additionalProperties": false, "properties": { "type": { "enum": [...names, "none"] } } }`.

## Prompt

Built from a fixed template plus, per field, the type label, the field label (uk) and the kind. `prompt_hash` is the
sha256 of the rendered prompt; `registry_hash` the sha256 of the sorted registry files. Both are stored with every
extraction and printed by the evaluation.

## Checks (rules the pipeline executes, C11)

| rule | parameters | fails with |
| --- | --- | --- |
| `vat_sum` | net, vat, gross, rate | `VALIDATION_FAILED {check: "vat_sum", ...}` when `net + vat != gross` or `vat != round(net * rate / 100)` exactly, in kopiyky |
| `date_order` | earlier, later | `VALIDATION_FAILED` when both present and `earlier > later` |
| `edrpou` | field | `VALIDATION_FAILED` when the 8-digit check digit does not verify |
| `iban_ua` | field | `VALIDATION_FAILED` when length, `UA` prefix or mod 97 fails |
| required (business) | from `required` | `MISSING_REQUIRED_FIELD {field}` when the field is absent or not found |
| fragment located | every field | `VALIDATION_FAILED {field, fragment, page}` when the fragment is not in the page text |

## Normalisation (C11), pinned

Applied to both the page text and the fragment before the search: Unicode NFC; apostrophe variants (`'`, `’`, `ʼ`,
`‘`, ``) to `'`; non-breaking and thin spaces to a space; runs of whitespace to one space; soft hyphen removed; a
hyphen followed by a line break joins the word. Offsets are mapped back to the stored text. Date parsing accepts
`DD.MM.YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD` and the Ukrainian month names in the genitive; money accepts thousands
separated by spaces or non-breaking spaces and a comma or dot decimal mark; `грн`, `UAH` and `₴` mean UAH.
