import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { crc32, deflateSync } from 'node:zlib';
import { fixedDosDate, fixedDosTime, place, run, sha256 } from './generate.ts';

/**
 * The hostile set (T035, acceptance check 8, spec Edge Cases): files that the intake and the parser must refuse or
 * flag, one for every way the parser has to end a job without text. They are written on demand, with
 * `node fixtures/hostile.ts`, into the inbox next to the fixtures, and they are never listed in `manifest.json`, so
 * the intake gives them the class `unverified`. Every file is a function of this program and the tools in the image,
 * so a second run leaves them unchanged. Nothing here is a real attack: each file only claims or lacks something.
 */

/** One hostile file, the reason code it is meant to end with, and the status that comes with that code. */
type Hostile = { file: string; reason: string; status: 'REJECTED' | 'NEEDS_REVIEW'; bytes: Buffer };

/** The data of one zip entry. */
type ZipEntry = { name: string; data: Buffer };

/**
 * A zip file with stored (uncompressed) entries and the fixed clock, built by hand because no zip tool is in the
 * image. Used for the `.zip` that no route accepts and as the body of the truncated DOCX.
 */
function zipStored(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(fixedDosTime, 10);
    local.writeUInt16LE(fixedDosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(fixedDosTime, 12);
    central.writeUInt16LE(fixedDosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    parts.push(local, name, entry.data);
    offset += local.length + name.length + entry.data.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/** A DOCX with one paragraph, the smallest the format allows, as a stored zip. */
function minimalDocx(): Buffer {
  const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, 'utf8');
  return zipStored([
    { name: '[Content_Types].xml', data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>Test paragraph of a document that is cut off.</w:t></w:r></w:p>'.repeat(40)}</w:body></w:document>`) },
  ]);
}

/**
 * A PDF written by hand: `pages` pages that share one content stream, which draws `text` or nothing. Written by
 * hand because the 5000-page file must exist without any tool having to render 5000 pages, and because the blank page
 * must be blank. The pages hang flat under one `/Pages` node, which the format allows.
 */
function handmadePdf(pages: number, text: string | null): Buffer {
  const content = text === null ? '' : `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const first = 5;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_unused, index) => `${first + index} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>'),
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A PNG chunk: length, type, data and the CRC32 over type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * A PNG whose header says 30000 x 30000 pixels and whose body is a few bytes: the size is claimed, not carried. A
 * reader that trusts the header and allocates for it, as an image decoder would, is the target; the parser must read
 * the dimensions from the header and refuse before anything is decoded (R8).
 */
function oversizedPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(30000, 0);
  header.writeUInt32BE(30000, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(91_000))), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Builds the seven files; the scratch folder holds what the external tools read and write. */
async function buildAll(work: string): Promise<Hostile[]> {
  const plain = path.join(work, 'protected-source.pdf');
  const encrypted = path.join(work, 'protected.pdf');
  await writeFile(plain, handmadePdf(1, 'A document behind a password.'));
  // 128-bit AES: its keys derive from the passwords and the fixed id, while the 256-bit mode draws random salts.
  await run('qpdf', ['--static-id', '--static-aes-iv', '--encrypt', 'user-password', 'owner-password', '128', '--use-aes=y', '--', plain, encrypted]);
  const noise = path.join(work, 'noise.png');
  // Blurred random noise cut to black and white: Tesseract reads blobs as words and is unsure of nearly all of them.
  await run('convert', ['-limit', 'thread', '1', '-size', '1240x1754', 'xc:gray50', '-seed', '11', '+noise', 'Random', '-blur', '0x2', '-threshold', '48%', '-strip', '-define', 'png:exclude-chunk=all', noise]);
  const docx = minimalDocx();
  return [
    { file: 'hostile-5000-pages.pdf', reason: 'TOO_LARGE', status: 'REJECTED', bytes: handmadePdf(5000, null) },
    { file: 'hostile-30000px.png', reason: 'TOO_LARGE', status: 'REJECTED', bytes: oversizedPng() },
    { file: 'hostile-password.pdf', reason: 'ENCRYPTED', status: 'REJECTED', bytes: await readFile(encrypted) },
    { file: 'hostile-truncated.docx', reason: 'CORRUPT', status: 'REJECTED', bytes: docx.subarray(0, Math.floor(docx.length * 0.6)) },
    { file: 'hostile-archive.zip', reason: 'UNSUPPORTED_FORMAT', status: 'REJECTED', bytes: zipStored([{ name: 'readme.txt', data: Buffer.from('An archive is not a document.\n', 'utf8') }]) },
    { file: 'hostile-blank.pdf', reason: 'EMPTY', status: 'NEEDS_REVIEW', bytes: handmadePdf(1, null) },
    { file: 'hostile-noise.png', reason: 'LOW_OCR_QUALITY', status: 'NEEDS_REVIEW', bytes: await readFile(noise) },
  ];
}

/** Writes the hostile set into the inbox; prints one line per file with the reason code it should end with. */
async function main(): Promise<void> {
  const replace = process.argv.includes('--replace');
  const work = await mkdtemp(path.join(tmpdir(), 'hostile-'));
  const lines: string[] = [];
  for (const entry of await buildAll(work)) {
    const placed = await place(entry.file, entry.bytes, replace);
    lines.push(`${placed.padEnd(9)} ${sha256(entry.bytes).slice(0, 12)} ${String(entry.bytes.length).padStart(8)} B  ${entry.status.padEnd(12)} ${entry.reason.padEnd(18)} ${entry.file}`);
  }
  console.log(lines.join('\n'));
  await rm(work, { recursive: true });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
