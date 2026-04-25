import type {
  AppLogBatchRequest,
  AppLogBatchResponse,
  AppLogInfo,
  AppLogInput,
  AppLogLevel,
  AppLogListResponse,
  AppLogSource,
} from "../../packages/shared/types";
import { sql } from "./db";

const LOG_LEVELS = new Set<AppLogLevel>(["debug", "info", "warn", "error", "fatal"]);
const LOG_SOURCES = new Set<AppLogSource>(["frontend", "backend"]);
const MAX_LOGS_PER_BATCH = 100;
const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_LENGTH = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_JSON_DEPTH = 8;

type StoredAppLog = {
  source: AppLogSource;
  level: AppLogLevel;
  event: string;
  message: string | null;
  tags: string[];
  context: unknown;
  client: unknown;
  request?: unknown;
  url?: string | null;
  userAgent?: string | null;
  clientLogId?: string | null;
  clientCreatedAt?: string | null;
};

export async function handleClientLogRequest(req: Request, body: AppLogBatchRequest): Promise<AppLogBatchResponse> {
  const logs = Array.isArray(body?.logs) ? body.logs.slice(0, MAX_LOGS_PER_BATCH) : [];
  let accepted = 0;
  for (const log of logs) {
    const stored = normalizeLogInput(log, "frontend", req);
    if (!stored) continue;
    await insertAppLog(stored);
    accepted += 1;
  }
  return { ok: true, accepted };
}

export async function listAppLogs(req: Request): Promise<AppLogListResponse> {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100));
  const rows = await sql`
    select
      id,
      source,
      level,
      event,
      message,
      tags,
      context,
      client,
      request,
      url,
      user_agent,
      client_log_id,
      client_created_at,
      created_at
    from app_logs
    order by id desc
    limit ${limit}
  `;
  return { logs: rows.map(mapAppLogRow) };
}

export async function logBackendEvent(input: AppLogInput) {
  try {
    const stored = normalizeLogInput(input, "backend");
    if (stored) await insertAppLog(stored);
  } catch (error) {
    console.warn("failed to persist app log", error instanceof Error ? error.message : String(error));
  }
}

export function sanitizeForJsonb(value: unknown): unknown {
  return sanitizeJson(value, 0, new WeakSet<object>());
}

function normalizeLogInput(input: AppLogInput, fallbackSource: AppLogSource, req?: Request): StoredAppLog | null {
  if (!input || typeof input !== "object") return null;
  const source = req ? fallbackSource : LOG_SOURCES.has(input.source as AppLogSource) ? (input.source as AppLogSource) : fallbackSource;
  const level = LOG_LEVELS.has(input.level) ? input.level : "info";
  const event = cleanText(input.event, 160);
  if (!event) return null;

  const url = req ? new URL(req.url) : null;
  return {
    source,
    level,
    event,
    message: input.message === undefined || input.message === null ? null : cleanText(String(input.message), 4000),
    tags: normalizeTags(input.tags),
    context: sanitizeForJsonb(input.context ?? {}),
    client: sanitizeForJsonb(input.client ?? {}),
    request: req
      ? sanitizeForJsonb({
          path: url?.pathname,
          query: url ? Object.fromEntries(url.searchParams.entries()) : {},
          method: req.method,
          ip: req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for"),
          cfRay: req.headers.get("cf-ray"),
        })
      : {},
    url: req?.headers.get("referer") ?? null,
    userAgent: req?.headers.get("user-agent") ?? null,
    clientLogId: typeof input.id === "string" ? cleanText(input.id, 200) : null,
    clientCreatedAt: validDate(input.createdAt) ?? null,
  };
}

async function insertAppLog(log: StoredAppLog) {
  await sql`
    insert into app_logs (
      source,
      level,
      event,
      message,
      tags,
      context,
      client,
      request,
      url,
      user_agent,
      client_log_id,
      client_created_at
    )
    values (
      ${log.source},
      ${log.level},
      ${log.event},
      ${log.message},
      ${log.tags}::text[],
      ${log.context}::jsonb,
      ${log.client}::jsonb,
      ${log.request ?? {}}::jsonb,
      ${log.url ?? null},
      ${log.userAgent ?? null},
      ${log.clientLogId ?? null},
      ${log.clientCreatedAt ?? null}
    )
  `;
}

function mapAppLogRow(row: any): AppLogInfo {
  return {
    id: String(row.id),
    source: LOG_SOURCES.has(row.source) ? row.source : "backend",
    level: LOG_LEVELS.has(row.level) ? row.level : "info",
    event: row.event,
    message: row.message ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    context: row.context ?? {},
    client: row.client ?? {},
    request: row.request ?? {},
    url: row.url ?? null,
    userAgent: row.user_agent ?? null,
    clientLogId: row.client_log_id ?? null,
    clientCreatedAt: dateString(row.client_created_at),
    createdAt: dateString(row.created_at) ?? new Date().toISOString(),
  };
}

function normalizeTags(tags: unknown) {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    const text = cleanText(String(tag), 80);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 16) break;
  }
  return out;
}

function cleanText(value: string, max: number) {
  const withoutNul = redactSensitiveText(value.replace(/\u0000/g, "\uFFFD")).trim();
  return withoutNul.length > max ? `${withoutNul.slice(0, max)}...` : withoutNul;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "<redacted-openrouter-key>")
    .replace(/\bim_[A-Za-z0-9_-]{16,}\b/g, "<redacted-import-token>")
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, "$1<redacted>");
}

function validDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function dateString(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return String(value);
}

function sanitizeJson(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_JSON_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value, MAX_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return sanitizeJson(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      depth + 1,
      seen,
    );
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeJson(item, depth + 1, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      out[cleanText(key, 120)] = sanitizeJson(item, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}
