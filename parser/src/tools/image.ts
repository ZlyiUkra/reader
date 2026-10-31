import { open } from 'node:fs/promises';
import { runTool } from './run.ts';
import type { ToolBudget } from './run.ts';

/** The pixel size an image declares in its header. */
export type ImageSize = {
  width: number;
  height: number;
};

/** The bytes of a file head that the header readers look at; a JPEG may carry a long EXIF block before its frame header. */
const headBytes = 256 * 1024;

/** Reads the first bytes of a file and nothing more: sizes are read from headers before any decoder sees the file. */
async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(buffer, 0, headBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The dimensions in the IHDR chunk of a PNG, or null when the file does not start with the PNG signature and a header
 * chunk. The numbers are what the file claims: a PNG that says 30000 x 30000 is refused on this claim, before anything
 * is decoded or allocated (R8, acceptance check 8).
 */
export async function readPngSize(path: string): Promise<ImageSize | null> {
  const head = await readHead(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 24 || !head.subarray(0, 8).equals(signature) || head.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null;
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * The dimensions in the first frame header (a `SOFn` marker) of a JPEG, found by stepping over the segments from the
 * start, or null when the file is not a JPEG or the frame header is not in the head of the file.
 */
export async function readJpegSize(path: string): Promise<ImageSize | null> {
  const head = await readHead(path);
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) {
      return null;
    }
    const marker = head[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = head.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return offset + 9 <= head.length ? { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Writes a PNG preview of an image with ImageMagick: shrunk to the preview width when it is wider, never enlarged,
 * metadata stripped. The decoder is named explicitly (`png:` or `jpeg:`) so ImageMagick does not guess the format from the
 * content, and its own limits on pixels and memory sit below the container's.
 */
export async function previewImage(input: string, format: 'png' | 'jpeg', output: string, widthPx: number, budget: ToolBudget): Promise<void> {
  await runTool(
    'convert',
    ['-limit', 'memory', '256MiB', '-limit', 'map', '256MiB', '-limit', 'width', '8000', '-limit', 'height', '8000', '-limit', 'thread', '1', `${format}:${input}[0]`, '-resize', `${widthPx}x>`, '-strip', `png:${output}`],
    budget,
  );
}
