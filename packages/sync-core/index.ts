export type BytesLike = string | Uint8Array;

export type SyncMode = "append" | "snapshot";
export type PolicyAction = "sync" | "ignore" | "noise";

export type SyncPolicyRule = {
  pattern: string;
  action?: PolicyAction;
  mode?: SyncMode;
  rateLimitMs?: number;
  maxBytes?: number;
  maxRecords?: number;
};

export type PolicyMatchOptions = {
  homeDir?: string;
};

export type PolicyDecision = {
  action: PolicyAction;
  ignored: boolean;
  noise: boolean;
  mode: SyncMode;
  rateLimitMs?: number;
  maxBytes?: number;
  maxRecords?: number;
  matchedRules: SyncPolicyRule[];
};

export type FileStatSnapshot = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  inode?: number | string;
  dev?: number | string;
};

export type SyncCursor = {
  generation: number;
  size: number;
  offset: number;
  lineNo: number;
  tailSha256?: string;
  mtimeMs: number;
  ctimeMs: number;
  inode?: number | string;
  dev?: number | string;
};

export type SyncDecisionReason = "new" | "unchanged" | "append" | "truncated" | "rotated" | "tail-mismatch";

export type SyncDecision =
  | {
      kind: "skip";
      reason: "unchanged";
      generation: number;
      cursor: SyncCursor;
    }
  | {
      kind: "append" | "snapshot";
      reason: Exclude<SyncDecisionReason, "unchanged">;
      generation: number;
      startOffset: number;
      startLineNo: number;
      cursor: SyncCursor;
    };

export type AppendChunkRecord = {
  offset: number;
  lineNo: number;
  bytes: Uint8Array;
  text: string;
  sha256: string;
};

export type AppendChunkPlan = {
  records: AppendChunkRecord[];
  emittedBytes: Uint8Array;
  emittedByteLength: number;
  pendingByteLength: number;
  hasMore: boolean;
  limitedBy?: "maxBytes" | "maxRecords";
  nextCursorCandidate?: SyncCursor;
};

export type AppendChunkOptions = {
  maxBytes?: number;
  maxRecords?: number;
  tailBytes?: number;
  previousTailBytes?: BytesLike;
};

const DEFAULT_TAIL_BYTES = 4096;

export function evaluatePolicy(path: string, rules: SyncPolicyRule[], options: PolicyMatchOptions = {}): PolicyDecision {
  const decision: PolicyDecision = {
    action: "sync",
    ignored: false,
    noise: false,
    mode: "snapshot",
    matchedRules: [],
  };

  for (const rule of rules) {
    if (!matchesPolicyPath(path, rule.pattern, options)) continue;
    decision.matchedRules.push(rule);

    if (rule.action) decision.action = rule.action;
    if (rule.mode) decision.mode = rule.mode;
    if (rule.rateLimitMs !== undefined) decision.rateLimitMs = rule.rateLimitMs;
    if (rule.maxBytes !== undefined) decision.maxBytes = rule.maxBytes;
    if (rule.maxRecords !== undefined) decision.maxRecords = rule.maxRecords;
  }

  decision.ignored = decision.action === "ignore";
  decision.noise = decision.action === "noise";
  return decision;
}

export function matchesPolicyPath(path: string, pattern: string, options: PolicyMatchOptions = {}) {
  const target = parsePolicyPath(path, options.homeDir);
  const glob = parsePolicyPath(pattern, options.homeDir);
  if (glob.absolute && !target.absolute) return false;
  if (!glob.absolute && target.absolute) {
    return matchSegments(glob.segments, target.segments) || matchSegments(["**", ...glob.segments], target.segments);
  }
  return matchSegments(glob.segments, target.segments);
}

export function decideSync(cursor: SyncCursor | undefined, stat: FileStatSnapshot, currentTailSha256?: string): SyncDecision {
  if (!cursor) {
    const generation = 1;
    return {
      kind: "snapshot",
      reason: "new",
      generation,
      startOffset: 0,
      startLineNo: 0,
      cursor: cursorForStart(generation, stat),
    };
  }

  if (hasIdentityChanged(cursor, stat)) {
    const generation = cursor.generation + 1;
    return {
      kind: "snapshot",
      reason: "rotated",
      generation,
      startOffset: 0,
      startLineNo: 0,
      cursor: cursorForStart(generation, stat),
    };
  }

  if (stat.size < cursor.offset) {
    const generation = cursor.generation + 1;
    return {
      kind: "snapshot",
      reason: "truncated",
      generation,
      startOffset: 0,
      startLineNo: 0,
      cursor: cursorForStart(generation, stat),
    };
  }

  if (cursor.offset > 0 && cursor.tailSha256 && currentTailSha256 && cursor.tailSha256 !== currentTailSha256) {
    const generation = cursor.generation + 1;
    return {
      kind: "snapshot",
      reason: "tail-mismatch",
      generation,
      startOffset: 0,
      startLineNo: 0,
      cursor: cursorForStart(generation, stat),
    };
  }

  if (stat.size === cursor.offset) {
    return {
      kind: "skip",
      reason: "unchanged",
      generation: cursor.generation,
      cursor: { ...cursor, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, inode: stat.inode, dev: stat.dev },
    };
  }

  return {
    kind: "append",
    reason: "append",
    generation: cursor.generation,
    startOffset: cursor.offset,
    startLineNo: cursor.lineNo,
    cursor: { ...cursor, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, inode: stat.inode, dev: stat.dev },
  };
}

export function planAppendChunk(
  chunk: BytesLike,
  cursor: SyncCursor,
  stat: FileStatSnapshot,
  options: AppendChunkOptions = {},
): AppendChunkPlan {
  const bytes = toBytes(chunk);
  const maxBytes = positiveLimit(options.maxBytes);
  const maxRecords = positiveLimit(options.maxRecords);
  const records: AppendChunkRecord[] = [];
  let emittedLength = 0;
  let lineNo = cursor.lineNo;
  let limitedBy: AppendChunkPlan["limitedBy"];

  while (emittedLength < bytes.length) {
    if (records.length >= maxRecords) {
      limitedBy = "maxRecords";
      break;
    }

    const newlineIndex = indexOfByte(bytes, 0x0a, emittedLength);
    if (newlineIndex < 0) break;

    const recordEnd = newlineIndex + 1;
    if (recordEnd > maxBytes) {
      limitedBy = "maxBytes";
      break;
    }

    const recordBytes = bytes.slice(emittedLength, newlineIndex);
    lineNo += 1;
    records.push({
      offset: cursor.offset + emittedLength,
      lineNo,
      bytes: recordBytes,
      text: new TextDecoder().decode(recordBytes),
      sha256: sha256Hex(recordBytes),
    });
    emittedLength = recordEnd;

    if (emittedLength >= maxBytes) {
      if (emittedLength < bytes.length) limitedBy = "maxBytes";
      break;
    }
  }

  const emittedBytes = bytes.slice(0, emittedLength);
  const nextOffset = cursor.offset + emittedLength;
  const nextCursorCandidate =
    emittedLength > 0
      ? {
          generation: cursor.generation,
          size: stat.size,
          offset: nextOffset,
          lineNo,
          tailSha256: tailSha256(options.previousTailBytes, emittedBytes, options.tailBytes ?? DEFAULT_TAIL_BYTES),
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          inode: stat.inode,
          dev: stat.dev,
        }
      : undefined;

  return {
    records,
    emittedBytes,
    emittedByteLength: emittedLength,
    pendingByteLength: bytes.length - emittedLength,
    hasMore: nextOffset < stat.size,
    limitedBy,
    nextCursorCandidate,
  };
}

export function sha256Hex(data: BytesLike): string {
  const bytes = toBytes(data);
  const words = sha256Words(bytes);
  return words.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function cursorForStart(generation: number, stat: FileStatSnapshot): SyncCursor {
  return {
    generation,
    size: stat.size,
    offset: 0,
    lineNo: 0,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    inode: stat.inode,
    dev: stat.dev,
  };
}

function hasIdentityChanged(cursor: SyncCursor, stat: FileStatSnapshot) {
  if (cursor.inode === undefined || stat.inode === undefined) return false;
  if (String(cursor.inode) !== String(stat.inode)) return true;
  if (cursor.dev === undefined || stat.dev === undefined) return false;
  return String(cursor.dev) !== String(stat.dev);
}

function tailSha256(previousTail: BytesLike | undefined, emittedBytes: Uint8Array, tailBytes: number) {
  const prefix = previousTail ? toBytes(previousTail) : new Uint8Array();
  const merged = concatBytes(prefix, emittedBytes);
  const tail = merged.slice(Math.max(0, merged.length - Math.max(1, tailBytes)));
  return tail.length > 0 ? sha256Hex(tail) : undefined;
}

function positiveLimit(value: number | undefined) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

function parsePolicyPath(value: string, homeDir?: string) {
  let normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "~" && homeDir) normalized = homeDir;
  if (normalized.startsWith("~/") && homeDir) normalized = `${homeDir.replaceAll("\\", "/").replace(/\/+$/, "")}/${normalized.slice(2)}`;
  normalized = normalized.replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/");
  const segments = normalized.split("/").filter(Boolean);
  return { absolute, segments };
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    if (matchSegments(rest, path)) return true;
    return path.length > 0 && matchSegments(pattern, path.slice(1));
  }
  return path.length > 0 && matchSegment(head, path[0]) && matchSegments(rest, path.slice(1));
}

function matchSegment(pattern: string, value: string) {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let valueRetryIndex = 0;

  while (valueIndex < value.length) {
    const patternChar = pattern[patternIndex];
    if (patternChar === "?" || patternChar === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternChar === "*") {
      starIndex = patternIndex;
      valueRetryIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      valueRetryIndex += 1;
      valueIndex = valueRetryIndex;
    } else {
      return false;
    }
  }

  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function indexOfByte(bytes: Uint8Array, byte: number, from: number) {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] === byte) return i;
  }
  return -1;
}

function toBytes(value: BytesLike) {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Words(message: Uint8Array) {
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, low);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = add32(w[i - 16], s0, w[i - 7], s1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, ch, SHA256_K[i], w[i]);
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(s0, maj);

      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    h0 = add32(h0, a);
    h1 = add32(h1, b);
    h2 = add32(h2, c);
    h3 = add32(h3, d);
    h4 = add32(h4, e);
    h5 = add32(h5, f);
    h6 = add32(h6, g);
    h7 = add32(h7, h);
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7];
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function add32(...values: number[]) {
  let out = 0;
  for (const value of values) out = (out + value) >>> 0;
  return out;
}
