import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path/posix';
import { test } from 'node:test';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { placeholders } from '../src/shared/format.ts';

/**
 * The two interface languages are complete (T040, FR-057, FR-058): the page's own dictionaries have the same keys and the
 * same placeholders in each text, every field label of the schema registry exists in Ukrainian and in English, and so does
 * every message template of the reasons file, variants included. A text missing in one language is a defect found here, not
 * a blank or a raw key in front of the owner.
 */
const i18nDir = path.join(import.meta.dirname, '..', 'web', 'src', 'i18n');
const config = await loadConfig(resolveConfigDirs(process.env));
const registry = createRegistry(config.typeSchemas);

/** Reads a dictionary file and narrows it to a flat map of strings, refusing anything else. */
async function dictionary(file: string): Promise<Record<string, string>> {
  const parsed: unknown = JSON.parse(await readFile(path.join(i18nDir, file), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `${file} is an object`);
  const entries = Object.entries(parsed);
  for (const [key, value] of entries) {
    assert.equal(typeof value, 'string', `${file}: ${key} is a string`);
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

const uk = await dictionary('uk.json');
const en = await dictionary('en.json');

/** The placeholders of a text, sorted, so two languages can be compared. */
function placeholdersOf(text: string): string[] {
  return [...new Set(placeholders(text))].sort();
}

test('the two dictionaries have equal key sets', () => {
  assert.deepEqual(Object.keys(uk).sort(), Object.keys(en).sort());
});

test('every text of both dictionaries is not empty and names the same placeholders in both languages', () => {
  for (const key of Object.keys(uk)) {
    assert.ok((uk[key] ?? '').trim().length > 0, `uk ${key} is not empty`);
    assert.ok((en[key] ?? '').trim().length > 0, `en ${key} is not empty`);
    assert.deepEqual(placeholdersOf(uk[key] ?? ''), placeholdersOf(en[key] ?? ''), `${key}: the placeholders of the two languages`);
  }
});

test('every label of the registry, of each type and each field, exists in Ukrainian and in English', () => {
  assert.ok(registry.types.length >= 3);
  for (const type of registry.types) {
    for (const lang of ['uk', 'en'] as const) {
      assert.ok(type.labels[lang].trim().length > 0, `${type.name} ${lang}`);
      for (const field of type.fields) {
        assert.ok(field.labels[lang].trim().length > 0, `${type.name}.${field.name} ${lang}`);
      }
    }
  }
});

test('every reasons template and every variant template exists in Ukrainian and in English with the same placeholders', () => {
  assert.equal(config.reasons.reasons.length, 15);
  for (const entry of config.reasons.reasons) {
    const texts = [{ where: entry.code, templates: entry.templates }, ...(entry.variants ?? []).map((variant, index) => ({ where: `${entry.code} variant ${index + 1}`, templates: variant.templates }))];
    for (const { where, templates } of texts) {
      assert.ok(templates.uk.trim().length > 0, `${where} uk`);
      assert.ok(templates.en.trim().length > 0, `${where} en`);
      assert.deepEqual(placeholdersOf(templates.uk), placeholdersOf(templates.en), `${where}: the placeholders of the two languages`);
    }
  }
});

test('every to-do item of the header exists in both languages, with its trigger', async () => {
  const { todoList } = await import('../src/config/todo.ts');
  assert.ok(todoList.length > 0);
  for (const item of todoList) {
    for (const lang of ['uk', 'en'] as const) {
      assert.ok(item[lang].trim().length > 0, `${item.id} ${lang}`);
      assert.ok(item.trigger[lang].trim().length > 0, `${item.id} trigger ${lang}`);
    }
  }
});

/**
 * The technical names the code stores in the parameters of a reason: the program that could not read the file (`tool`), the
 * limit that was breached (`limit`) and the cause of an internal error (`cause`). The page shows each under a name of the
 * dictionary, so the owner reads "LibreOffice" and not `soffice`. These are the values the code emits today
 * (`parser/src/parse.ts`, `parser/src/server.ts`, `app/src/pipeline/failures.ts`, `model-call.ts`, `db/claim.ts`); the
 * parser's sources are not in this image, so the values are listed here and a new one is added here and to both dictionaries.
 */
const technicalValues: Record<string, string[]> = {
  tool: ['soffice', 'pdfinfo', 'pdftotext', 'pdftoppm', 'pdfimages', 'tesseract', 'rsvg-convert', 'convert', 'file', 'render', 'image'],
  limit: [
    'prompt_tokens',
    'num_predict',
    'tool_memory_mb',
    'tool_output_bytes',
    'convert_timeout_s',
    'ocr_timeout_s_per_page',
    'render_timeout_s_per_page',
    'png_max_side_px',
    'png_max_bytes',
    'text_max_bytes',
    'page_size_pt',
    'page_cap',
  ],
  cause: [
    'lease_expired',
    'child_exit',
    'child_output',
    'child_start',
    'job_deadline',
    'job_folders_missing',
    'local_only',
    'model_reply',
    'model_transport',
    'model_timeout',
    'model_http',
    'model_invalid_reply',
    'model_recording',
    'parser_connect',
    'parser_busy',
    'parser_timeout',
    'parser_protocol',
    'unsafe_output',
    'unexpected',
    'parser',
  ],
};

test('every technical name a reason can carry has a human name in both languages, and no name is left without a value', () => {
  const listed = new Set<string>();
  for (const [group, values] of Object.entries(technicalValues)) {
    for (const value of values) {
      const key = `${group}.${value}`;
      listed.add(key);
      for (const [lang, dictionaryOf] of [['uk', uk], ['en', en]] as const) {
        const name = dictionaryOf[key] ?? '';
        assert.ok(name.trim().length > 0, `${lang} ${key} has a name`);
        assert.notEqual(name, value, `${lang} ${key} is not the technical name itself`);
      }
    }
  }
  for (const key of Object.keys(uk).filter((candidate) => /^(tool|limit|cause)\./.test(candidate))) {
    assert.ok(listed.has(key), `${key} names a value the code emits`);
  }
});
