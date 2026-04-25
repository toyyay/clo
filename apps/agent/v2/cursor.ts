import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type { AppendJsonlCursor, InventoryFile, TailBatch, TailRecord } from "./types";

export type ReadAppendJsonlOptions = {
  readChunkBytes: number;
};

const TAIL_BYTES = 4096;

export async function readAppendJsonl(
  file: InventoryFile,
  current: AppendJsonlCursor | undefined,
  options: ReadAppendJsonlOptions,
): Promise<TailBatch> {
  const fileStat = await stat(file.sourcePath);
  const reset = await shouldResetCursor(file.sourcePath, current, fileStat);
  let cursor = reset
    ? cursorWithStat(0, 0, fileStat, undefined, (current?.generation ?? 1) + 1)
    : current ?? cursorWithStat(0, 0, fileStat);
  const readChunkBytes = Math.max(1, options.readChunkBytes);

  if (fileStat.size <= cursor.offset) {
    return {
      file,
      records: [],
      rawStartOffset: cursor.offset,
      rawBytes: new Uint8Array(),
      nextCursor: cursorWithStat(cursor.offset, cursor.lineNo, fileStat, cursor.tailSha256, cursor.generation),
      truncated: fileStat.size < cursor.offset,
      reset,
    };
  }

  const handle = await open(file.sourcePath, "r");
  let buffer: Buffer;
  try {
    buffer = await readThroughNewline(handle, cursor.offset, fileStat.size, readChunkBytes);
  } finally {
    await handle.close();
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return {
      file,
      records: [],
      rawStartOffset: cursor.offset,
      rawBytes: new Uint8Array(),
      nextCursor: cursorWithStat(cursor.offset, cursor.lineNo, fileStat, cursor.tailSha256, cursor.generation),
      truncated: false,
      reset,
    };
  }

  const complete = buffer.subarray(0, lastNewline + 1);
  const records: TailRecord[] = [];
  const decoder = new TextDecoder("utf-8");
  let localOffset = 0;
  let lineNo = cursor.lineNo;

  while (localOffset < complete.length) {
    const nlIdx = complete.indexOf(0x0a, localOffset);
    if (nlIdx < 0) break;
    const lineBytes = complete.subarray(localOffset, nlIdx);
    const rawLine = decoder.decode(lineBytes);
    const absoluteOffset = cursor.offset + localOffset;
    localOffset = nlIdx + 1;
    lineNo += 1;
    if (!rawLine.trim()) continue;
    records.push({
      lineNo,
      offset: absoluteOffset,
      byteLength: lineBytes.length + 1,
      rawLine,
    });
  }

  return {
    file,
    records,
    rawStartOffset: cursor.offset,
    rawBytes: new Uint8Array(complete),
    nextCursor: cursorWithStat(
      cursor.offset + complete.length,
      lineNo,
      fileStat,
      sha256Hex(await readTailBeforeOffset(file.sourcePath, cursor.offset + complete.length)),
      cursor.generation,
    ),
    truncated: false,
    reset,
  };
}

async function shouldResetCursor(
  sourcePath: string,
  current: AppendJsonlCursor | undefined,
  fileStat: Awaited<ReturnType<typeof stat>>,
): Promise<boolean> {
  if (!current) return false;
  if (fileStat.size < current.offset) return true;
  if (current.ino !== undefined && current.dev !== undefined && (current.ino !== statNumber(fileStat.ino) || current.dev !== statNumber(fileStat.dev))) {
    return true;
  }
  if (current.offset > 0 && current.tailSha256) {
    const tail = await readTailBeforeOffset(sourcePath, current.offset);
    if (tail.length > 0 && sha256Hex(tail) !== current.tailSha256) return true;
  }
  return false;
}

async function readThroughNewline(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  size: number,
  readChunkBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = offset;
  let total = 0;

  while (position < size) {
    const length = Math.min(readChunkBytes, size - position);
    const chunk = Buffer.alloc(length);
    const result = await handle.read(chunk, 0, length, position);
    if (result.bytesRead <= 0) break;
    const actual = chunk.subarray(0, result.bytesRead);
    chunks.push(actual);
    total += actual.length;
    position += result.bytesRead;
    if (actual.includes(0x0a)) break;
  }

  return Buffer.concat(chunks, total);
}

async function readTailBeforeOffset(sourcePath: string, offset: number): Promise<Buffer> {
  const start = Math.max(0, offset - TAIL_BYTES);
  const length = offset - start;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function cursorWithStat(
  offset: number,
  lineNo: number,
  fileStat: Awaited<ReturnType<typeof stat>>,
  tailSha256?: string,
  generation = 1,
): AppendJsonlCursor {
  return {
    generation,
    offset,
    lineNo,
    sizeBytes: statNumber(fileStat.size),
    mtimeMs: statNumber(fileStat.mtimeMs),
    tailSha256,
    dev: statNumber(fileStat.dev),
    ino: statNumber(fileStat.ino),
  };
}

function statNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
