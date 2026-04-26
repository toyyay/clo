import type { HostInfo, SessionEvent, SessionInfo, SessionPayload, SyncResponse } from "../../packages/shared/types";
import { applySync, getMeta } from "./db";

export const READ_API_ENDPOINTS = {
  sync: "/api/sync",
  v2Hosts: "/api/v2/hosts",
  v2Sessions: "/api/v2/sessions",
  v2SessionEvents: (sessionId: string) => `/api/v2/sessions/${encodeURIComponent(sessionId)}/events`,
  legacyHosts: "/api/hosts",
  legacySessions: "/api/sessions",
  legacySession: (sessionId: string) => `/api/session?id=${encodeURIComponent(sessionId)}`,
} as const;

export type SessionMetadataPayload = {
  hosts: HostInfo[];
  sessions: SessionInfo[];
  source: "v2" | "legacy";
};

export type SessionEventsPayload = {
  session?: SessionInfo;
  events: SessionEvent[];
  source: "v2" | "legacy";
};

export type PullResult = {
  events: number;
  batches: number;
  cursor: string;
  backfillCursor?: string;
  backfillHasMore: boolean;
  eventMode?: "forward" | "recent" | "backfill";
  metadataCursor?: string;
  hasMore: boolean;
  hosts: number;
  sessions: number;
  metadataFull: boolean;
  touchedSessionIds: string[];
};

export type PullProgress = {
  events: number;
  batches: number;
  hasMore: boolean;
};

export type PullOptions = {
  limitBytes?: number;
  maxBatches?: number;
  timeoutMs?: number;
  metadataOnly?: boolean;
  eventMode?: "forward" | "recent" | "backfill";
  onProgress?: (progress: PullProgress) => void;
};

export class SyncAuthError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`sync failed: ${status} ${body}`);
    this.name = "SyncAuthError";
    this.status = status;
  }
}

const DEFAULT_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BATCHES = 4;
const DEFAULT_TIMEOUT_MS = 20_000;

let preferredReadApi: "v2" | "legacy" | null = null;

export function metadataModeForCursor(metadataCursor?: string): "full" | "delta" {
  return metadataCursor ? "delta" : "full";
}

export function metadataPruneMode(payload: Pick<SyncResponse, "metadataFull" | "metadataMode">, previousMetadataCursor?: string) {
  return payload.metadataFull === true || (payload.metadataMode !== "delta" && !previousMetadataCursor) ? "full-shell" : "none";
}

class ReadApiError extends Error {
  status: number;
  body: string;
  constructor(url: string, status: number, body: string) {
    super(`${url} failed: ${status} ${body}`);
    this.name = "ReadApiError";
    this.status = status;
    this.body = body;
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new ReadApiError(url, response.status, await response.text());
  return (await response.json()) as T;
}

function shouldFallBackToLegacy(error: unknown) {
  return error instanceof ReadApiError && (error.status === 404 || error.status === 405 || error.status === 501);
}

function rememberReadApi(source: "v2" | "legacy") {
  preferredReadApi = source;
}

function normalizeSessionEventsPayload(
  payload: SessionPayload | SessionEvent[] | { session?: SessionInfo; events?: SessionEvent[] },
  source: "v2" | "legacy",
): SessionEventsPayload {
  if (Array.isArray(payload)) {
    return {
      events: payload,
      source,
    };
  }
  if (payload.session && Array.isArray(payload.events)) return { session: payload.session, events: payload.events, source };
  throw new Error(`${source} session events payload was not recognized`);
}

async function fetchBatch(
  cursor: string,
  limitBytes: number,
  timeoutMs: number,
  metadataOnly: boolean,
  metadataCursor?: string,
  eventMode?: "forward" | "recent" | "backfill",
  backfillCursor?: string,
): Promise<SyncResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const metadataMode = metadataOnly ? metadataModeForCursor(metadataCursor) : undefined;
    const response = await fetch(READ_API_ENDPOINTS.sync, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor, limitBytes, metadataOnly, metadataCursor, metadataMode, eventMode, backfillCursor }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) throw new SyncAuthError(response.status, body);
      throw new Error(`sync failed: ${response.status} ${body}`);
    }
    return (await response.json()) as SyncResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("sync timed out");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchSessionMetadata(): Promise<SessionMetadataPayload> {
  if (preferredReadApi !== "legacy") {
    try {
      const [hosts, sessions] = await Promise.all([
        readJson<HostInfo[]>(READ_API_ENDPOINTS.v2Hosts),
        readJson<SessionInfo[]>(READ_API_ENDPOINTS.v2Sessions),
      ]);
      rememberReadApi("v2");
      return { hosts, sessions, source: "v2" };
    } catch (error) {
      if (!shouldFallBackToLegacy(error)) throw error;
    }
  }
  const [hosts, sessions] = await Promise.all([
    readJson<HostInfo[]>(READ_API_ENDPOINTS.legacyHosts),
    readJson<SessionInfo[]>(READ_API_ENDPOINTS.legacySessions),
  ]);
  rememberReadApi("legacy");
  return { hosts, sessions, source: "legacy" };
}

export async function fetchSessionEvents(sessionId: string): Promise<SessionEventsPayload> {
  if (preferredReadApi !== "legacy") {
    try {
      const payload = await readJson<SessionPayload | SessionEvent[] | { session?: SessionInfo; events?: SessionEvent[] }>(
        READ_API_ENDPOINTS.v2SessionEvents(sessionId),
      );
      rememberReadApi("v2");
      return normalizeSessionEventsPayload(payload, "v2");
    } catch (error) {
      if (!shouldFallBackToLegacy(error)) throw error;
    }
  }
  const payload = await readJson<SessionPayload>(READ_API_ENDPOINTS.legacySession(sessionId));
  rememberReadApi("legacy");
  return normalizeSessionEventsPayload(payload, "legacy");
}

export async function pullUpdates(options: PullOptions = {}): Promise<PullResult> {
  const limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES;
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const metadataOnly = options.metadataOnly !== false;
  const onProgress = options.onProgress;
  const storedCursor = await getMeta<string>("syncCursor");
  let cursor = storedCursor ?? "0";
  let backfillCursor = await getMeta<string>("backfillCursor");
  const eventMode = metadataOnly ? undefined : options.eventMode ?? (storedCursor ? "forward" : "recent");
  let metadataCursor = await getMeta<string>("metadataCursor");
  let events = 0;
  let batches = 0;
  let hasMore = false;
  let backfillHasMore = false;
  let hosts = 0;
  let sessions = 0;
  let metadataFull = false;
  const touchedSessionIds = new Set<string>();

  while (batches < maxBatches) {
    const previousCursor = cursor;
    const previousMetadataCursor = metadataCursor;
    const previousBackfillCursor = backfillCursor;
    const payload = await fetchBatch(previousCursor, limitBytes, timeoutMs, metadataOnly, metadataCursor, eventMode, backfillCursor);
    const nextHasMore = metadataOnly
      ? payload.metadataHasMore === true || payload.hasMore === true
      : eventMode === "backfill"
        ? payload.backfillHasMore === true
        : payload.hasMore;
    if (!metadataOnly && eventMode !== "backfill" && payload.hasMore && payload.cursor === previousCursor) {
      throw new Error("sync cursor did not advance");
    }
    if (!metadataOnly && eventMode === "backfill" && payload.backfillHasMore && payload.backfillCursor === previousBackfillCursor) {
      throw new Error("backfill cursor did not advance");
    }
    if (metadataOnly && nextHasMore && payload.metadataCursor === previousMetadataCursor) {
      throw new Error("metadata cursor did not advance");
    }
    if (!metadataOnly && eventMode !== "backfill") cursor = payload.cursor;
    backfillCursor = payload.backfillCursor ?? backfillCursor;
    backfillHasMore = payload.backfillHasMore === true;
    metadataCursor = payload.metadataCursor ?? metadataCursor;
    hasMore = nextHasMore;
    metadataFull = metadataFull || payload.metadataFull === true || (metadataOnly && payload.metadataMode !== "delta" && !previousMetadataCursor);
    hosts += payload.hosts.length;
    sessions += payload.sessions.length;
    await applySync(payload, {
      pruneMissing: metadataOnly ? metadataPruneMode(payload, previousMetadataCursor) : "none",
      storeEventCursor: !metadataOnly && eventMode !== "backfill",
    });
    for (const event of payload.events) touchedSessionIds.add(event.sessionDbId);
    events += payload.events.length;
    batches += 1;
    onProgress?.({ events, batches, hasMore });
    if (!hasMore) break;
  }

  return {
    events,
    batches,
    cursor,
    backfillCursor,
    backfillHasMore: !metadataOnly ? backfillHasMore : false,
    eventMode,
    metadataCursor,
    hasMore,
    hosts,
    sessions,
    metadataFull,
    touchedSessionIds: [...touchedSessionIds],
  };
}
