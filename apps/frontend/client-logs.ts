import type { AppLogInput, AppLogLevel } from "../../packages/shared/types";
import { withTimeout } from "./app-utils";
import { openCacheDb } from "./db";

type QueuedClientLog = AppLogInput & {
  id: string;
  source: "frontend";
  createdAt: string;
};

const MAX_QUEUED_LOGS = 2000;
const FLUSH_BATCH_SIZE = 100;
const MAX_TEXT_LENGTH = 4000;
const MAX_JSON_DEPTH = 6;
const MAX_ARRAY_LENGTH = 80;
const MAX_OBJECT_KEYS = 80;
const IDB_LOG_TIMEOUT_MS = 1200;
const IDB_LOG_RETRY_DELAY_MS = 30000;
const MEMORY_LOG_LIMIT = 100;

const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

let installed = false;
let requestLoggingInstalled = false;
let flushing = false;
let memoryFlushing = false;
let idbLoggingDisabledUntil = 0;
const memoryLogs: QueuedClientLog[] = [];
const pageSessionId = newLogId();
let originalFetch: typeof fetch | null = null;

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

export function installClientRequestLogging() {
  if (requestLoggingInstalled) return;
  if (typeof window === "undefined") return;
  requestLoggingInstalled = true;
  originalFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const meta = requestLogMeta(input, init);
    const fetchImpl = rawFetch();
    if (!meta.shouldLog) return fetchImpl(input, init);

    const slowTimer = window.setTimeout(() => {
      void logClientEvent(
        "warn",
        "client.api_request.slow",
        `${meta.method} ${meta.path} is still running`,
        {
          requestId: meta.requestId,
          method: meta.method,
          path: meta.path,
          query: meta.query,
          durationMs: Math.round(performance.now() - started),
          activeElement: document.activeElement?.tagName ?? null,
          visibilityState: document.visibilityState,
          online: navigator.onLine,
        },
        ["client", "request"],
      );
    }, 2500);

    try {
      const response = await fetchImpl(meta.input, meta.init);
      window.clearTimeout(slowTimer);
      const durationMs = Math.round(performance.now() - started);
      void logClientEvent(
        response.ok ? "debug" : "warn",
        "client.api_request.complete",
        null,
        {
          requestId: meta.requestId,
          method: meta.method,
          path: meta.path,
          query: meta.query,
          status: response.status,
          ok: response.ok,
          redirected: response.redirected,
          durationMs,
          responseRequestId: response.headers.get("x-chatview-request-id"),
          contentType: response.headers.get("content-type"),
          contentLength: response.headers.get("content-length"),
        },
        ["client", "request"],
      );
      return response;
    } catch (error) {
      window.clearTimeout(slowTimer);
      void logClientEvent(
        "error",
        "client.api_request.failed",
        error instanceof Error ? error.message : String(error),
        {
          requestId: meta.requestId,
          method: meta.method,
          path: meta.path,
          query: meta.query,
          durationMs: Math.round(performance.now() - started),
          error: errorToContext(error),
          online: navigator.onLine,
        },
        ["client", "request"],
      );
      throw error;
    }
  }) as typeof window.fetch;
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
    void enqueueLogWithFallback(log);
  } catch (error) {
    originalConsole.warn("failed to queue client log", error);
  }
}

export async function flushClientLogs(limit = FLUSH_BATCH_SIZE) {
  if (flushing) return { sent: 0 };
  if (navigator.onLine === false) return { sent: 0 };
  flushing = true;
  try {
    let sent = await flushMemoryLogs();
    if (Date.now() < idbLoggingDisabledUntil) return { sent };
    const logs = await withTimeout(loadQueuedLogs(limit), IDB_LOG_TIMEOUT_MS, "client log IndexedDB load timed out").catch((error) => {
      markIdbLoggingUnavailable(error);
      return [] as QueuedClientLog[];
    });
    if (!logs.length) return { sent };
    await sendLogs(logs);
    await withTimeout(deleteQueuedLogs(logs.map((log) => log.id)), IDB_LOG_TIMEOUT_MS, "client log delete timed out").catch((error) => {
      markIdbLoggingUnavailable(error);
    });
    sent += logs.length;
    return { sent };
  } finally {
    flushing = false;
  }
}

async function enqueueLogWithFallback(log: QueuedClientLog) {
  if (Date.now() < idbLoggingDisabledUntil) {
    queueMemoryLog(log);
    if (navigator.onLine) void flushMemoryLogs().catch(() => {});
    return;
  }

  try {
    await withTimeout(enqueueLog(log), IDB_LOG_TIMEOUT_MS, "client log IndexedDB queue timed out");
    if (log.level !== "debug" && navigator.onLine) void flushClientLogs().catch(() => {});
  } catch (error) {
    markIdbLoggingUnavailable(error);
    queueMemoryLog(log);
    if (navigator.onLine) void flushMemoryLogs().catch(() => {});
  }
}

function queueMemoryLog(log: QueuedClientLog) {
  memoryLogs.push(log);
  while (memoryLogs.length > MEMORY_LOG_LIMIT) memoryLogs.shift();
}

async function flushMemoryLogs() {
  if (memoryFlushing || navigator.onLine === false || !memoryLogs.length) return 0;
  memoryFlushing = true;
  const logs = memoryLogs.slice(0, FLUSH_BATCH_SIZE);
  try {
    await sendLogs(logs);
    const sentIds = new Set(logs.map((log) => log.id));
    for (let index = memoryLogs.length - 1; index >= 0; index -= 1) {
      if (sentIds.has(memoryLogs[index].id)) memoryLogs.splice(index, 1);
    }
    return logs.length;
  } finally {
    memoryFlushing = false;
  }
}

async function sendLogs(logs: QueuedClientLog[]) {
  if (!logs.length) return;
  const body = JSON.stringify({ logs });
  const response = await rawFetch()("/api/app/logs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chatview-client-request-id": newLogId(),
      "x-chatview-page-session-id": pageSessionId,
    },
    body,
    keepalive: body.length < 60_000,
  });
  if (!response.ok) throw new Error(`log upload failed: ${response.status}`);
}

function rawFetch() {
  return originalFetch ?? globalThis.fetch.bind(globalThis);
}

function requestLogMeta(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const rawUrl = request?.url ?? String(input);
  const url = new URL(rawUrl, window.location.href);
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  const shouldLog = url.origin === window.location.origin && path.startsWith("/api/") && path !== "/api/app/logs";
  const requestId = newLogId();
  if (!shouldLog) return { shouldLog, input, init, requestId, method, path, query: sanitizeQuery(url) };

  const headers = new Headers(init?.headers ?? request?.headers);
  headers.set("x-chatview-client-request-id", requestId);
  headers.set("x-chatview-page-session-id", pageSessionId);
  const nextInit = { ...init, headers };
  const nextInput = request ? new Request(request, nextInit) : input;
  return {
    shouldLog,
    input: nextInput,
    init: request ? undefined : nextInit,
    requestId,
    method,
    path,
    query: sanitizeQuery(url),
  };
}

function sanitizeQuery(url: URL) {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const normalized = key.toLowerCase();
    out[key] = normalized.includes("token") || normalized.includes("key") ? "<redacted>" : cleanText(value, 500);
  }
  return out;
}

function markIdbLoggingUnavailable(error: unknown) {
  idbLoggingDisabledUntil = Date.now() + IDB_LOG_RETRY_DELAY_MS;
  originalConsole.warn("client log IndexedDB unavailable; using network fallback", error);
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
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
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
