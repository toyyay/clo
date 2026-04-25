import type {
  JsonObject,
  NormalizeOptions,
  TranscriptEvent,
  TranscriptEventKind,
  TranscriptPart,
  TranscriptRole,
  TranscriptSourceMetadata,
} from "./types";

const textEncoder = new TextEncoder();

export function kindForRoleAndParts(role: TranscriptRole, parts: TranscriptPart[], rawType?: string): TranscriptEventKind {
  const lowerType = rawType?.toLowerCase() ?? "";
  if (lowerType.includes("session")) return "session";
  if (lowerType.includes("turn")) return "turn";
  if (lowerType.includes("meta")) return "meta";
  if (parts.length && parts.every((part) => part.kind === "thinking")) return "thinking";
  if (parts.length && parts.every((part) => part.kind === "tool_call")) return "tool_call";
  if (parts.length && parts.every((part) => part.kind === "tool_result")) return "tool_result";
  return role === "system" ? "event" : "message";
}

export function sourceMetadata(
  raw: unknown,
  options: NormalizeOptions & { rawType?: string; rawKind?: string },
): TranscriptSourceMetadata {
  const object = asObject(raw);
  return {
    provider: options.provider ?? "unknown",
    sourcePath: options.sourcePath,
    lineNo: options.lineNo,
    byteOffset: options.byteOffset,
    rawType: options.rawType ?? stringValue(object?.type),
    rawKind: options.rawKind ?? stringValue(object?.kind) ?? stringValue(object?.event) ?? stringValue(object?.type),
  };
}

export function nonDisplayEvent(
  raw: unknown,
  options: NormalizeOptions & { rawType?: string; rawKind?: string },
): TranscriptEvent {
  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: options.rawKind ?? "event", data: raw }],
    display: false,
    source: sourceMetadata(raw, options),
    raw,
  };
}

export function normalizeRole(value?: string): TranscriptRole {
  const lower = value?.toLowerCase();
  if (lower === "user" || lower === "human") return "user";
  if (lower === "assistant" || lower === "model" || lower === "agent") return "assistant";
  if (lower === "tool" || lower === "function") return "tool";
  return "system";
}

export function extractTimestamp(...objects: Array<JsonObject | undefined>): string | undefined {
  for (const object of objects) {
    if (!object) continue;
    for (const key of ["timestamp", "created_at", "createdAt", "time", "date"]) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

export function compactEventData(object?: JsonObject): unknown {
  if (!object) return undefined;
  const data = { ...object };
  delete data.type;
  delete data.kind;
  delete data.event;
  return Object.keys(data).length ? data : undefined;
}

export function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function utf8ByteLength(value: string) {
  return textEncoder.encode(value).byteLength;
}
