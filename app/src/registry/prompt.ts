import { createHash } from 'node:crypto';
import type { FieldKind, Registry, RegistryType } from './registry.ts';

/**
 * The prompts of the two model calls, built from the registry and a fixed template (contracts/type-schema.md, FR-041).
 * Nothing about a type is written here by hand: the type label, the field names, their Ukrainian labels and their kinds
 * come from the schema files, so a new type needs no change to this module.
 */

/** A prompt as the LLM port takes it (contracts/llm-port.md), with the hash that identifies its instructions. */
export type Prompt = {
  system: string;
  user: string;
  /**
   * SHA-256 of the system text and the instructions of the user text, taken before the page texts are appended. It
   * identifies the wording and the registry it was built from, not one document, so it can be stored with every
   * extraction and compared between runs (FR-032, FR-048).
   */
  hash: string;
};

/** How each kind is described to the model; the pipeline derives the typed value from the quoted fragment itself. */
const kindHint: Record<FieldKind, string> = {
  string: 'text',
  date: 'a date',
  money: 'an amount of money',
  enum: 'one of a closed list of values',
  edrpou: 'an 8-digit company code (EDRPOU)',
  iban: 'a bank account number (IBAN)',
};

const classifySystem =
  'You classify a document into exactly one of the listed types, or "none" if it is none of them. ' +
  'Answer only with JSON that matches the given schema. Do not explain.';

const extractSystem =
  'You read a document and report fields from it. Answer only with JSON that matches the given schema. ' +
  'For every field give "verbatim", the value itself exactly as it is written in the document, copied character by character, ' +
  'and nothing else: not the name of the field, not a word such as "від", "№", "код" or "до" in front of it, and no other words around it. ' +
  'For example, for the line "Дата: від 12.03.2026" the verbatim of a date is "12.03.2026". ' +
  'Also give "page", the number of the page (the first page is 1) where that value is. ' +
  'If the document does not contain the field, give null for both. Never guess and never invent a value. Do not explain.';

/** Joins the page texts under their page numbers; the model answers with the same numbers. */
function pagesBlock(pages: string[]): string {
  return pages.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join('\n\n');
}

/** Assembles a prompt: the hash covers the instructions, the page texts follow them and stay out of it. */
function assemble(system: string, instructions: string, pages: string[]): Prompt {
  const hash = createHash('sha256').update(system).update('\0').update(instructions).digest('hex');
  return { system, user: pages.length === 0 ? instructions : `${instructions}\n\nDocument text:\n${pagesBlock(pages)}`, hash };
}

/** The classification prompt: the registered types with their Ukrainian labels, then the page texts. */
export function classifyPrompt(registry: Registry, pages: string[]): Prompt {
  const lines = registry.types.map((type) => `- ${type.name}: ${type.labels.uk}`);
  const instructions = ['Choose the type of the document:', ...lines, '- none: the document is none of the types above'].join('\n');
  return assemble(classifySystem, instructions, pages);
}

/** The extraction prompt of one type: the type label and, per field, its name, kind and Ukrainian label, then the page texts. */
export function extractPrompt(type: RegistryType, pages: string[]): Prompt {
  const lines = type.fields.map((field) => `- ${field.name} (${kindHint[field.kind]}): ${field.labels.uk}`);
  const instructions = [`The document is of the type "${type.labels.uk}". Report these fields:`, ...lines].join('\n');
  return assemble(extractSystem, instructions, pages);
}
