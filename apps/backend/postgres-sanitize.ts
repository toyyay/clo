const MAX_JSON_DEPTH = 40;
const MAX_JSON_ARRAY = 10_000;
const MAX_JSON_OBJECT_KEYS = 10_000;

export function sanitizePostgresText(value: string) {
  return toWellFormedText(value).replace(/\u0000/g, "<nul>");
}

export function sanitizeOptionalPostgresText(value: string | null | undefined) {
  return value == null ? null : sanitizePostgresText(value);
}

export function sanitizePostgresRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePostgresJson(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

export function sanitizePostgresJson(value: unknown): unknown {
  return sanitizeJsonValue(value, 0, new WeakSet<object>());
}

export function toWellFormedText(value: string) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += value[index];
    }
  }
  return out;
}

function sanitizeJsonValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_JSON_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizePostgresText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return sanitizeJsonValue({ name: value.name, message: value.message, stack: value.stack }, depth + 1, seen);
  }
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_ARRAY).map((item) => sanitizeJsonValue(item, depth + 1, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_JSON_OBJECT_KEYS)) {
      out[sanitizePostgresText(key)] = sanitizeJsonValue(item, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return sanitizePostgresText(String(value));
}
