import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { test } from 'node:test';
import { parserSocketPath, probeParser } from '../src/parser-client/client.ts';

/**
 * The health probe of the parser (FR-065): it says whether something accepts connections on the parser's socket, and it
 * says no, quickly, for a socket that is missing or has nobody behind it. It must never start a job, so a listening
 * server that sees only a connection opened and closed is all it takes.
 */

test('the socket of the parser is parser.sock in the jobs folder', () => {
  assert.equal(parserSocketPath('/jobs'), '/jobs/parser.sock');
});

test('a socket with a listener is up, and the probe only opens and closes a connection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reader-probe-'));
  const socketPath = parserSocketPath(dir);
  let connections = 0;
  let bytes = 0;
  const listener = createServer((socket) => {
    connections += 1;
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  try {
    assert.equal(await probeParser(socketPath), true);
    assert.equal(await probeParser(socketPath), true);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the listener sees a connection a moment after the client does
    assert.equal(connections, 2);
    assert.equal(bytes, 0);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true });
  }
});

test('a socket that nobody listens on is down: stopped listener, missing file, missing folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reader-probe-'));
  const socketPath = parserSocketPath(dir);
  try {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    assert.equal(await probeParser(socketPath), false);
    assert.equal(await probeParser(path.join(dir, 'other.sock')), false);
    assert.equal(await probeParser(path.join(dir, 'no', 'such', 'folder.sock')), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});
