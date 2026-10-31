import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path/posix';
import type { ParserManifest, ParserManifestPage } from '../../src/config/types.ts';

/**
 * A stand-in for the parser's socket, for the tests of the parse step: it answers `POST /parse {jobId}` the way the real
 * service does (contracts/parser.md) and writes whatever output the test asks for into the job's `out/` folder. The real
 * parser is exercised separately against the running stack; here only the app's handling of its answers is under test.
 */

/** What the fake does for one job: write output and answer ok, or answer with a reason. */
export type FakeBehaviour = (jobId: string, outDir: string) => Promise<{ ok: true } | { ok: false; code: string; params: Record<string, string | number> }>;

/** The smallest byte string the safe reader accepts as a PNG: the signature and a header chunk of the given size. */
export function pngOf(width: number, height: number): Buffer {
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13, 0);
  header.write('IHDR', 4, 'ascii');
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), header]);
}

/** A page entry of a manifest. */
export function pageEntry(n: number, source: 'text_layer' | 'ocr', ocrWordsTotal = 0, ocrWordsLow = 0): ParserManifestPage {
  return {
    n,
    source,
    engine: source === 'ocr' ? 'tesseract' : 'pdftotext',
    engineVersion: '1',
    dpi: source === 'ocr' ? 300 : null,
    widthPx: 8,
    heightPx: 8,
    ocrWordsTotal: source === 'ocr' ? ocrWordsTotal : null,
    ocrWordsLow: source === 'ocr' ? ocrWordsLow : null,
    timingsMs: { render: 1, text: 1, ocr: source === 'ocr' ? 1 : 0 },
  };
}

/** A page of a job: its manifest entry and its text. */
export type FakePage = { entry: ParserManifestPage; text: string };

/** Writes a complete, valid output for the given pages, with the manifest last, and answers ok. */
export async function writeOutput(jobId: string, outDir: string, pages: FakePage[]): Promise<{ ok: true }> {
  await mkdir(outDir, { recursive: true });
  for (const page of pages) {
    await writeFile(path.join(outDir, `page-${page.entry.n}.png`), pngOf(8, 8));
    await writeFile(path.join(outDir, `page-${page.entry.n}.txt`), page.text);
    if (page.entry.source === 'ocr') {
      await writeFile(path.join(outDir, `page-${page.entry.n}.tsv`), 'level\tpage_num\n');
    }
  }
  const manifest: ParserManifest = {
    version: 1,
    jobId,
    detectedMime: 'application/pdf',
    converter: null,
    pageCount: pages.length,
    pages: pages.map((page) => page.entry),
    timingsMs: { detect: 1, convert: 0, pdfinfo: 1, total: 4 },
    limitsHit: [],
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
  return { ok: true };
}

/** Starts the fake on `<jobsDir>/parser.sock`. `behaviour` can be replaced between jobs through the returned handle. */
export async function startFakeParser(jobsDir: string, initial: FakeBehaviour): Promise<{ close: () => Promise<void>; behave: (next: FakeBehaviour) => void; requests: string[] }> {
  let behaviour = initial;
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { jobId: string };
      requests.push(body.jobId);
      behaviour(body.jobId, path.join(jobsDir, 'out', body.jobId)).then(
        (answer) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ jobId: body.jobId, ...answer }));
        },
        () => {
          response.writeHead(500);
          response.end('{}');
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(path.join(jobsDir, 'parser.sock'), resolve));
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    behave: (next) => {
      behaviour = next;
    },
    requests,
  };
}
