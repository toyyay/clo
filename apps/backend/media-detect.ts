import { sanitizePostgresText } from "./postgres-sanitize";

export type MediaDetection = {
  kind: "audio";
  format: string;
  metadata: Record<string, unknown>;
};

export function detectMedia(bytes: Uint8Array, contentType?: string, filename?: string): MediaDetection | null {
  const lowerType = contentType?.toLowerCase() ?? "";
  const extension = fileExtension(filename);

  if (isMp4Like(bytes)) {
    const metadata = parseMp4Metadata(Buffer.from(bytes));
    return { kind: "audio", format: metadata.majorBrand === "qt  " ? "quicktime" : "m4a/mp4", metadata };
  }
  if (startsWithAscii(bytes, 0, "caff")) return { kind: "audio", format: "caf", metadata: {} };
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WAVE")) return { kind: "audio", format: "wav", metadata: {} };
  if (startsWithAscii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { kind: "audio", format: "mp3", metadata: {} };
  }

  if (lowerType.startsWith("audio/") || ["m4a", "mp4", "mov", "qta", "caf", "wav", "aac", "mp3"].includes(extension ?? "")) {
    return { kind: "audio", format: lowerType || extension || "audio", metadata: {} };
  }

  return null;
}

export function filenameFromContentDisposition(value: string | null) {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return cleanHeaderFilename(decodeURIComponentSafe(utf8[1].trim().replace(/^"|"$/g, "")));
  const ascii = value.match(/filename="?([^";]+)"?/i);
  return cleanHeaderFilename(ascii?.[1]);
}

export function fileExtension(filename?: string) {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1];
}

function parseMp4Metadata(bytes: Buffer): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const tags: Record<string, string> = {};
  const brands: string[] = [];
  const creationTimes: string[] = [];
  const durations: number[] = [];

  scanMp4Boxes(bytes, 0, bytes.length, [], 0, (box) => {
    if (box.type === "ftyp" && box.end - box.contentStart >= 8) {
      metadata.majorBrand = bytes.toString("latin1", box.contentStart, box.contentStart + 4);
      for (let offset = box.contentStart + 8; offset + 4 <= box.end; offset += 4) {
        brands.push(bytes.toString("latin1", offset, offset + 4));
      }
    }

    if ((box.type === "mvhd" || box.type === "mdhd") && box.end - box.contentStart >= 24) {
      const parsed = parseMp4TimeBox(bytes, box.contentStart, box.end);
      if (parsed.createdAt) creationTimes.push(parsed.createdAt);
      if (parsed.durationSeconds !== undefined) durations.push(parsed.durationSeconds);
      metadata[`${box.type}CreatedAt`] = parsed.createdAt ?? null;
      metadata[`${box.type}DurationSeconds`] = parsed.durationSeconds ?? null;
    }

    if (box.type === "data" && box.path.length >= 2 && box.end - box.contentStart > 8) {
      const key = box.path[box.path.length - 2];
      const raw = bytes.subarray(box.contentStart + 8, box.end);
      const value = raw.toString("utf8").replace(/\0+$/, "").trim();
      if (value) tags[key] = value;
    }
  });

  if (brands.length) metadata.compatibleBrands = brands;
  if (Object.keys(tags).length) metadata.tags = tags;
  const tagDate = tags["©day"] ?? tags.date ?? tags.creationdate ?? tags["com.apple.quicktime.creationdate"];
  metadata.createdAt = validDate(tagDate) ?? creationTimes.find(Boolean) ?? null;
  if (durations.length) metadata.durationSeconds = durations.find((value) => Number.isFinite(value) && value > 0) ?? null;
  return metadata;
}

type Mp4Box = {
  type: string;
  contentStart: number;
  end: number;
  path: string[];
};

function scanMp4Boxes(
  bytes: Buffer,
  start: number,
  end: number,
  path: string[],
  depth: number,
  visit: (box: Mp4Box) => void,
) {
  if (depth > 8) return;
  let offset = start;

  while (offset + 8 <= end) {
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;

    if (size32 === 1) {
      if (offset + 16 > end) break;
      size = Number(bytes.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;

    let contentStart = offset + headerSize;
    const boxEnd = offset + size;
    const boxPath = [...path, type];
    const box = { type, contentStart, end: boxEnd, path: boxPath };
    visit(box);

    if (type === "meta" && boxEnd - contentStart >= 4) contentStart += 4;
    if (["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst"].includes(type)) {
      scanMp4Boxes(bytes, contentStart, boxEnd, boxPath, depth + 1, visit);
    } else if (path.includes("ilst")) {
      scanMp4Boxes(bytes, contentStart, boxEnd, boxPath, depth + 1, visit);
    }

    offset = boxEnd;
  }
}

function parseMp4TimeBox(bytes: Buffer, start: number, end: number) {
  const version = bytes[start];
  const epochOffsetSeconds = Date.UTC(1904, 0, 1) / 1000;

  if (version === 1 && start + 32 <= end) {
    const createdSeconds = Number(bytes.readBigUInt64BE(start + 4));
    const timescale = bytes.readUInt32BE(start + 20);
    const duration = Number(bytes.readBigUInt64BE(start + 24));
    return {
      createdAt: quickTimeDate(createdSeconds, epochOffsetSeconds),
      durationSeconds: timescale ? duration / timescale : undefined,
    };
  }

  if (start + 20 <= end) {
    const createdSeconds = bytes.readUInt32BE(start + 4);
    const timescale = bytes.readUInt32BE(start + 12);
    const duration = bytes.readUInt32BE(start + 16);
    return {
      createdAt: quickTimeDate(createdSeconds, epochOffsetSeconds),
      durationSeconds: timescale ? duration / timescale : undefined,
    };
  }

  return {};
}

function quickTimeDate(seconds: number, epochOffsetSeconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date((seconds + epochOffsetSeconds) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function validDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function isMp4Like(bytes: Uint8Array) {
  for (let offset = 0; offset + 12 <= Math.min(bytes.length, 4096); ) {
    const size = readUInt32BE(bytes, offset);
    if (size < 8) return false;
    if (startsWithAscii(bytes, offset + 4, "ftyp")) return true;
    offset += size;
  }
  return false;
}

function readUInt32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
}

function startsWithAscii(bytes: Uint8Array, offset: number, value: string) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanHeaderFilename(value?: string) {
  const clean = value ? sanitizePostgresText(value).trim() : "";
  return clean || undefined;
}
