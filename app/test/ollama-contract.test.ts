import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAjv } from '../src/config/ajv.ts';
import { loadConfig, resolveConfigDirs } from '../src/config/load.ts';
import { createOllamaAdapter } from '../src/llm/ollama.ts';
import type { LlmRequest } from '../src/llm/port.ts';
import { modelSettings } from '../src/llm/settings.ts';
import { extractPrompt } from '../src/registry/prompt.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { wireSchema } from '../src/registry/wire.ts';

/**
 * The contract test of acceptance check 1 (constitution XI): the real model, asked five times for the invoice wire
 * schema on one fixed page text, must answer every time with JSON that parses and satisfies the schema, an empty
 * `thinking` and `done_reason: stop`, on the first request, with no fallback. It runs only where a model service answers
 * at `MODEL_URL`; in the GPU-free suite (check 9) the service is stopped and the five tests are skipped, which is the
 * one place that suite is allowed to skip. Whether the values are right is the evaluation's question, not this one's.
 */

/** A synthetic invoice page; every name, code and number is invented. */
const pageText = [
  'РАХУНОК-ФАКТУРА № РФ-2026/0412',
  'від 15 березня 2026 р.',
  '',
  'Постачальник: ТОВ «Тест-Постач», код ЄДРПОУ 12345678',
  'IBAN постачальника: UA213223130000026007233566001',
  'Покупець: ТОВ «Тест-Покупець», код ЄДРПОУ 87654321',
  'Договір № 17/2026 від 02.01.2026',
  '',
  'Консультаційні послуги за лютий 2026 р.',
  'Разом без ПДВ: 10 000,00 грн',
  'ПДВ 20%: 2 000,00 грн',
  'Разом з ПДВ: 12 000,00 грн',
  'Оплатити до 25.03.2026. Призначення платежу: оплата за рахунком № РФ-2026/0412.',
].join('\n');

/** True when a model service answers at `url`; a short timeout, because this decides whether the tests run at all. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

const modelUrl = process.env['MODEL_URL'];
const skip =
  modelUrl === undefined || modelUrl === ''
    ? 'MODEL_URL is not set'
    : (await answers(modelUrl))
      ? false
      : `the model service at ${modelUrl} does not answer`;

/** Everything the five tests share, built on first use so a skipped run reads no configuration. */
let shared: Promise<{ adapter: ReturnType<typeof createOllamaAdapter>; request: LlmRequest; schema: ReturnType<typeof wireSchema> }> | undefined;

/** Loads the real configuration and registry and builds the invoice request and the adapter once. */
function prepare(): NonNullable<typeof shared> {
  shared ??= (async () => {
    const config = await loadConfig(resolveConfigDirs(process.env));
    const registry = createRegistry(config.typeSchemas);
    const invoice = registry.byName.get('invoice');
    assert.ok(invoice !== undefined, 'the registry has the invoice type');
    const settings = modelSettings(config.thresholds);
    const schema = wireSchema(invoice);
    const prompt = extractPrompt(invoice, [pageText]);
    const request: LlmRequest = {
      kind: 'extract',
      documentNumber: 0,
      class: 'synthetic',
      system: prompt.system,
      user: prompt.user,
      wireSchema: schema,
      numPredict: settings.numPredict.extract,
    };
    assert.ok(modelUrl !== undefined);
    const adapter = createOllamaAdapter({ baseUrl: modelUrl, model: config.model, settings, logger: { info: () => undefined, warn: () => undefined } });
    return { adapter, request, schema };
  })();
  return shared;
}

for (let call = 1; call <= 5; call += 1) {
  test(`contract call ${call} of 5: valid JSON for the invoice wire schema, empty thinking, done_reason stop, no fallback`, { skip, timeout: 600_000 }, async (t) => {
    const { adapter, request, schema } = await prepare();
    const result = await adapter.call(request, new AbortController().signal);

    assert.equal(result.doneReason, 'stop');
    assert.equal((result.raw.request as { fallback: string }).fallback, 'none', 'the first structured chat request was enough');

    const message = (result.raw.response as { message?: { content?: unknown; thinking?: unknown } }).message;
    assert.equal(message?.thinking ?? '', '', 'thinking is empty');
    assert.equal(typeof message?.content, 'string');

    // The reply is parsed and validated here again, independently of the adapter, as the contract states it.
    const parsed: unknown = JSON.parse(String(message?.content));
    assert.ok(createAjv().compile(schema)(parsed), 'the reply satisfies the invoice wire schema');
    assert.deepEqual(result.json, parsed);

    t.diagnostic(
      `call ${call}: ${result.counts.promptEval ?? '?'} prompt tokens, ${result.counts.eval ?? '?'} generated, ` +
        `total ${Math.round((result.durationsNs.total ?? 0) / 1e6)} ms, load ${Math.round((result.durationsNs.load ?? 0) / 1e6)} ms, cold ${result.cold}`,
    );
  });
}
