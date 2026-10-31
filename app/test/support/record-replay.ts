import { loadConfig, resolveConfigDirs } from '../../src/config/load.ts';
import { reasonsOf } from '../../src/db/queries.ts';
import { createOllamaAdapter } from '../../src/llm/ollama.ts';
import { modelSettings } from '../../src/llm/settings.ts';
import { createRegistry } from '../../src/registry/registry.ts';
import { testDatabase } from './db.ts';
import { addParsedFixture, fixtureExpectations, outcomeOf, recordingAdapter, replayDir, sameOutcome, startPipeline, waitForTerminal } from './pipeline-harness.ts';

/**
 * The maintenance command that records the model's replies for the replay tests (T052, contracts/llm-port.md): the eleven
 * fixtures, as the golden parser outputs left them, go through classify, extract and check against the real model, and
 * every reply is written to the recordings folder under the key the replay adapter looks up. Run it only when the prompt or
 * a schema changed, with the model service up:
 *
 *   docker compose run --rm -e READER_RECORD=1 -e READER_RECORD_DIR=/record -v ./app/test/fixtures/replay:/record app node test/support/record-replay.ts
 *
 * It does nothing unless `READER_RECORD=1` is set, because `node --test` also runs every file under `test/`. The documents
 * go to `reader_test`, never to the owner's database. The recordings hold synthetic text only (constitution X).
 */
if (process.env['READER_RECORD'] === '1') {
  const env = process.env;
  const modelUrl = env['MODEL_URL'];
  if (modelUrl === undefined || modelUrl === '') {
    throw new Error('MODEL_URL is not set');
  }
  const config = await loadConfig(resolveConfigDirs(env));
  const settings = modelSettings(config.thresholds);
  const registry = createRegistry(config.typeSchemas);
  const log = (fields: object, message: string): void => console.log(message, JSON.stringify(fields));
  const logger = { info: log, warn: log, error: log };
  const real = createOllamaAdapter({ baseUrl: modelUrl, model: config.model, settings, logger });

  const deadline = Date.now() + 10 * 60_000;
  while ((await real.readiness()).state !== 'ready') {
    if (Date.now() > deadline) {
      throw new Error('The model did not become ready in 10 minutes');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const database = await testDatabase();
  try {
    const ids = new Map<string, number>();
    for (const expected of fixtureExpectations) {
      ids.set(expected.file, await addParsedFixture(database.pool, expected.file));
    }
    const worker = startPipeline({
      pool: database.pool,
      adapter: recordingAdapter(real, env['READER_RECORD_DIR'] ?? replayDir),
      classes: config.classes,
      registry,
      thresholds: config.thresholds,
      settings,
      logger,
    });
    await waitForTerminal(database.pool, [...ids.values()], 30 * 60_000);
    await worker.stop();

    let matched = 0;
    for (const expected of fixtureExpectations) {
      const id = ids.get(expected.file) ?? 0;
      const got = await outcomeOf(database.pool, id);
      const same = sameOutcome(expected, got);
      matched += same ? 1 : 0;
      console.log(`${same ? 'OK  ' : 'DIFF'} ${expected.file.padEnd(24)} expected ${expected.status} ${expected.codes.join(',') || '-'} | got ${got.status} ${got.codes.join(',') || '-'}`);
      if (!same) {
        console.log('     reasons:', JSON.stringify((await reasonsOf(database.pool, id)).map((reason) => ({ code: reason.code, params: reason.params }))));
      }
    }
    console.log(`${matched} of ${fixtureExpectations.length} fixtures match their expected result`);
    process.exitCode = matched === fixtureExpectations.length ? 0 : 1;
  } finally {
    await database.close();
  }
}
