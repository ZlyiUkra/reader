import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path/posix';
import { createAjv } from '../config/ajv.ts';
import { constants } from '../constants.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { LlmAdapterError } from './port.ts';
import type { LlmAdapter, LlmRequest, LlmResponse } from './port.ts';

/**
 * The replay adapter: serves model replies that were recorded earlier, so every test that would otherwise need the GPU
 * runs without it (constitution XI, acceptance check 9). It is the second consumer of the port. A recording is one
 * `LlmResponse` as JSON, named by the hash of the request; a request without a recording fails loudly instead of
 * inventing an answer, because a test that silently passes on a missing recording proves nothing.
 */

/** A request that has no recording; the message says which file to record. */
export class ReplayRecordingMissing extends Error {
  key: string;
  file: string;
  constructor(key: string, file: string) {
    super(`No recording for request ${key}: expected ${file}. Record the reply of the real model and store it there.`);
    this.name = 'ReplayRecordingMissing';
    this.key = key;
    this.file = file;
  }
}

/**
 * The key of a request: SHA-256 over everything that can change the reply (the kind, both texts, the wire schema and the
 * generation cap). The document number and the class do not reach the model, so they are not part of it.
 */
export function requestKey(req: Pick<LlmRequest, 'kind' | 'system' | 'user' | 'wireSchema' | 'numPredict'>): string {
  const hash = createHash('sha256');
  for (const part of [req.kind, req.system, req.user, canonicalJson(req.wireSchema), String(req.numPredict)]) {
    hash.update(part).update('\0');
  }
  return hash.digest('hex');
}

/** Narrows a parsed JSON value to an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a parsed recording has the fields of an `LlmResponse`; the values are checked where they are used. */
function looksLikeResponse(value: unknown): value is LlmResponse {
  return (
    isRecord(value) &&
    'json' in value &&
    isRecord(value['raw']) &&
    typeof value['modelName'] === 'string' &&
    typeof value['modelDigest'] === 'string' &&
    isRecord(value['counts']) &&
    isRecord(value['durationsNs']) &&
    typeof value['cold'] === 'boolean'
  );
}

/** Where the recording of a request lives inside the recordings folder. */
export function recordingFile(dir: string, req: Pick<LlmRequest, 'kind' | 'system' | 'user' | 'wireSchema' | 'numPredict'>): string {
  return path.join(dir, `${requestKey(req)}.json`);
}

/** Creates the adapter over a folder of recordings (`app/test/fixtures/replay/` in the tests). */
export function createReplayAdapter(dir: string): LlmAdapter {
  const ajv = createAjv();

  return {
    name: 'replay',
    local: true,

    async readiness() {
      return { state: 'ready', digest: null };
    },

    async call(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      signal.throwIfAborted();
      const file = recordingFile(dir, req);
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        throw new ReplayRecordingMissing(requestKey(req), file);
      }
      if (size > constants.maxModelReplyBytes) {
        throw new LlmAdapterError('recording', `The recording ${file} is larger than ${constants.maxModelReplyBytes} bytes.`);
      }
      let recording: unknown;
      try {
        recording = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new LlmAdapterError('recording', `The recording ${file} is not valid JSON.`);
      }
      if (!looksLikeResponse(recording)) {
        throw new LlmAdapterError('recording', `The recording ${file} is not a model response.`);
      }
      // The recorded value is checked against the schema of this request, whatever it was when recorded: a schema that
      // changed after the recording shows up here, as it would against a live model (FR-039).
      if (recording.doneReason !== 'length' && !ajv.validate(req.wireSchema, recording.json)) {
        throw new LlmAdapterError('recording', `The recording ${file} does not satisfy the wire schema of this request.`);
      }
      return recording;
    },
  };
}
