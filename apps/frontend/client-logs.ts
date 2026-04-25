import type { AppLogInput, AppLogLevel } from "../../packages/shared/types";
import { openCacheDb } from "./db";

type QueuedClientLog = AppLogInput & {
  id: string;
  source: "frontend";
  createdAt: string;
};

const MAX_QUEUED_LOGS = 500;
const FLUSH_BATCH_SIZE = 50;
const MAX_TEXT_LENGTH = 4000;
const MAX_JSON_DEPTH = 6;
const MAX_ARRAY_LENGTH = 80;
const MAX_OBJECT_KEYS = 80;

const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

let installed = false;
let flushing = false;
const pageSessionId = newLogId();

export function installClientLogHandlers() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    void logClientEvent(
      "error",
      "client.window_error",
      event.message,
      {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: errorToContext(event.error),
      },
      ["client", "runtime"],
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    void logClientEvent(
      "error",
      "client.unhandled_rejection",
      event.reason instanceof Error ? event.reason.message : String(event.reason),
      { reason: errorToContext(event.reason) },
      ["client", "runtime"],
    );
  });

  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    void logClientEvent("warn", "client.console_warn", stringifyArgs(args), { args }, ["client", "console"]);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    void logClientEvent("error", "client.console_error", stringifyArgs(args), { args }, ["client", "console"]);
  };
}

export async function logClientEvent(
  level: AppLogLevel,
  event: string,
  message?: string | null,
  context?: unknown,
  tags?: string[],
) {
  try {
    const log: QueuedClientLog = {
      id: newLogId(),
      source: "frontend",
      level,
      event: cleanText(event, 160) || "client.event",
      message: message == null ? null : cleanText(message, MAX_TEXT_LENGTH),
      tags: normalizeTags(tags),
      context: sanitizeForJsonb(context ?? {}),
      client: collectClientInfo(),
      createdAt: new Date().toISOString(),
    };
    await enqueueLog(log);
    if (level === "error" || level === "fatal" || navigator.onLine) void flushClientLogs().catch(() => {});
  } catch (error) {
    originalConsole.warn("failed to queue client log", error);
  }
}

export async function flushClientLogs(limit = FLUSH_BATCH_SIZE) {
  if (flushing) return { sent: 0 };
  if (navigator.onLine === false) return { sent: 0 };
  flushing = true;
  try {
    const logs = await loadQueuedLogs(limit);
    if (!logs.length) return { sent: 0 };
    const body = JSON.stringify({ logs });
    const response = await fetch("/api/app/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: body.length < 60_000,
    });
    if (!response.ok) throw new Error(`log upload failed: ${response.status}`);
    await deleteQueuedLogs(logs.map((log) => log.id));
    return { sent: logs.length };
  } finally {
    flushing = false;
  }
}

function collectClientInfo() {
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };

  return sanitizeForJsonb({
    pageSessionId,
    clientInstanceId: getClientInstanceId(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    vendor: navigator.vendor,
    maxTouchPoints: navigator.maxTouchPoints,
    cookieEnabled: navigator.cookieEnabled,
    online: navigator.onLine,
    visibilityState: document.visibilityState,
    url: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    referrer: document.referrer,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    screen: {
      width: window.screen?.width,
      height: window.screen?.height,
      availWidth: window.screen?.availWidth,
      availHeight: window.screen?.availHeight,
    },
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          downlink: nav.connection.downlink,
          rtt: nav.connection.rtt,
          saveData: nav.connection.saveData,
        }
      : null,
  });
}

function getClientInstanceId() {
  try {
    const key = "chatviewClientInstanceId";
    const current = window.localStorage.getItem(key);
    if (current) return current;
    const next = newLogId();
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return null;
  }
}

async function enqueueLog(log: QueuedClientLog) {
  const db = await openCacheDb();
  const tx = db.transaction("clientLogs", "readwrite");
  tx.objectStore("clientLogs").put(log);
  await transactionDone(tx);
  await trimQueuedLogs();
}

async function loadQueuedLogs(limit: number): Promise<QueuedClientLog[]> {
  const db = await openCacheDb();
  const store = db.transaction("clientLogs").objectStore("clientLogs");
  const logs = await request<QueuedClientLog[]>(store.index("createdAt").getAll(undefined, Math.max(1, limit)));
  return logs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function deleteQueuedLogs(ids: string[]) {
  if (!ids.length) return;
  const db = await openCacheDb();
  const tx = db.transaction("clientLogs", "readwrite");
  const store = tx.objectStore("clientLogs");
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
}

async function trimQueuedLogs() {
  const db = await openCacheDb();
  const count = await request<number>(db.transaction("clientLogs").objectStore("clientLogs").count());
  let toDelete = count - MAX_QUEUED_LOGS;
  if (toDelete <= 0) return;

  const tx = db.transaction("clientLogs", "readwrite");
  const store = tx.objectStore("clientLogs");
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.index("createdAt").openKeyCursor();
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || toDelete <= 0) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      toDelete -= 1;
      cursor.continue();
    };
  });
  await transactionDone(tx);
}

function newLogId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function stringifyArgs(args: unknown[]) {
  return cleanText(
    args
      .map((arg) => {
        if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(sanitizeForJsonb(arg));
        } catch {
          return String(arg);
        }
      })
      .join(" "),
    MAX_TEXT_LENGTH,
  );
}

function errorToContext(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

function sanitizeForJsonb(value: unknown): unknown {
  return sanitizeJson(value, 0, new WeakSet<object>());
}

function sanitizeJson(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_JSON_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value, MAX_TEXT_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return errorToContext(value);
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

function cleanText(value: string, max: number) {
  const clean = redactSensitiveText(value.replace(/\u0000/g, "\uFFFD")).trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "<redacted-openrouter-key>")
    .replace(/\bim_[A-Za-z0-9_-]{16,}\b/g, "<redacted-import-token>")
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, "$1<redacted>");
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}
