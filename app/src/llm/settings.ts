import { ConfigError } from '../config/load.ts';
import type { ThresholdsFile } from '../config/types.ts';
import type { LlmKind } from './port.ts';

/**
 * The model rows of config/thresholds.json (C13) as typed numbers, read once at start. Every value is still
 * "provisional" until the evaluation measures it, and the evaluation stores the file's values with each result.
 */
export type ModelSettings = {
  /** The server-wide context window; must equal `OLLAMA_CONTEXT_LENGTH` of the model service (FR-037). */
  numCtx: number;
  /** Generation cap per call kind. */
  numPredict: Record<LlmKind, number>;
  clientTimeoutS: number;
  /** A duration string as Ollama takes it, for example `30m`. */
  keepAlive: string;
  /** The estimate that turns characters into tokens for the budget check; calibrated by the evaluation. */
  charsPerToken: number;
  /** A load longer than this marks a call cold. */
  coldLoadNs: number;
  /** Sampling temperature of every call; 0 makes the reply a function of the request, so a run can be repeated. */
  temperature: number;
  /** Seed of the sampler, fixed for the same reason. */
  seed: number;
};

/** Reads one number of the thresholds file; a missing or non-numeric row is a configuration error naming the key. */
function numberOf(thresholds: ThresholdsFile, key: string): number {
  const value = thresholds.values[key]?.value;
  if (typeof value !== 'number') {
    throw new ConfigError(`config/thresholds.json: "${key}" must be a number.`);
  }
  return value;
}

/** Reads one string of the thresholds file, with the same refusal as `numberOf`. */
function stringOf(thresholds: ThresholdsFile, key: string): string {
  const value = thresholds.values[key]?.value;
  if (typeof value !== 'string') {
    throw new ConfigError(`config/thresholds.json: "${key}" must be a string.`);
  }
  return value;
}

/** Collects the model settings from the thresholds file. */
export function modelSettings(thresholds: ThresholdsFile): ModelSettings {
  return {
    numCtx: numberOf(thresholds, 'model.num_ctx'),
    numPredict: {
      classify: numberOf(thresholds, 'model.num_predict_classify'),
      extract: numberOf(thresholds, 'model.num_predict_extract'),
    },
    clientTimeoutS: numberOf(thresholds, 'model.client_timeout_s'),
    keepAlive: stringOf(thresholds, 'model.keep_alive'),
    charsPerToken: numberOf(thresholds, 'model.chars_per_token'),
    coldLoadNs: numberOf(thresholds, 'model.cold_load_ns'),
    temperature: numberOf(thresholds, 'model.temperature'),
    seed: numberOf(thresholds, 'model.seed'),
  };
}
