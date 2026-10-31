import type { ThresholdsFile } from './types.ts';

/**
 * Reads of the thresholds file (C13) that the pipeline repeats: one number by its key, and the snapshot of a group of
 * rows that is stored next to what the numbers produced. The file is validated at start, so a missing or non-numeric row
 * here is a defect of the caller's key, and it stops loudly instead of becoming `NaN` somewhere downstream.
 */

/** The value of a numeric row; throws when the row is missing or not a number. */
export function thresholdNumber(file: ThresholdsFile, key: string): number {
  const value = file.values[key]?.value;
  if (typeof value !== 'number') {
    throw new Error(`The threshold ${key} is missing or not a number`);
  }
  return value;
}

/**
 * The rows whose key starts with one of the prefixes, as a plain key-to-value map. It is stored with every page text, so
 * a reading can always be traced to the numbers that were in force when it was made (FR-032, C13).
 */
export function thresholdSnapshot(file: ThresholdsFile, prefixes: string[]): Record<string, number | string> {
  const snapshot: Record<string, number | string> = {};
  for (const [key, entry] of Object.entries(file.values)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      snapshot[key] = entry.value;
    }
  }
  return snapshot;
}
