import type {
  HostInfo,
  SessionEvent,
  SessionInfo,
  SessionPayload,
  SyncExclusionInfo,
  SyncExclusionKind,
  SyncExclusionsResponse,
  SyncResponse,
} from "../../packages/shared/types";
import { applySync, deleteMeta, getMeta, setMeta } from "./db";
import { clampRetentionDays } from "./storage-prefs";

export const READ_API_ENDPOINTS = {
  sync: "/api/sync",
  v2Hosts: "/api/v2/hosts",
  v2Sessions: "/api/v2/sessions",
  v2SessionEvents: (sessionId: string) => `/api/v2/sessions/${encodeURIComponent(sessionId)}/events`,
  syncExclusions: "/api/sync/exclusions",
  restoreSyncExclusion: (id: string) => `/api/sync/exclusions/${encodeURIComponent(id)}/restore`,
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
  lookbackDays?: number;
  onProgress?: (progress: PullProgress) => void;
};

type SyncEventMode = NonNullable<PullOptions["eventMode"]>;

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

export function eventModeForPull(options: {
  metadataOnly: boolean;
  requestedEventMode?: SyncEventMode;
  storedCursor?: string;
  backfillCursor?: string;
  backfillHasMore?: boolean;
}): SyncEventMode | undefined {
  if (options.metadataOnly) return undefined;
  if (options.requestedEventMode === "recent" && shouldResumeBackfill(options.backfillCursor, options.backfillHasMore)) {
    return "backfill";
  }
  if (!options.requestedEventMode && !options.storedCursor && shouldResumeBackfill(options.backfillCursor, options.backfillHasMore)) {
    return "backfill";
  }
  return options.requestedEventMode ?? (options.storedCursor ? "forward" : "recent");
}

function shouldResumeBackfill(backfillCursor: string | undefined, backfillHasMore: boolean | undefined) {
  return Boolean(backfillCursor) && backfillHasMore !== false;
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

function withLookback(url: string, lookbackDays?: number) {
  if (lookbackDays === undefined) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}lookbackDays=${encodeURIComponent(String(clampRetentionDays(lookbackDays)))}`;
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
  lookbackDays?: number,
): Promise<SyncResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const metadataMode = metadataOnly ? metadataModeForCursor(metadataCursor) : undefined;
    const response = await fetch(READ_API_ENDPOINTS.sync, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor, limitBytes, metadataOnly, metadataCursor, metadataMode, eventMode, backfillCursor, lookbackDays }),
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

export async function fetchSessionMetadata(lookbackDays?: number): Promise<SessionMetadataPayload> {
  if (preferredReadApi !== "legacy") {
    try {
      const [hosts, sessions] = await Promise.all([
        readJson<HostInfo[]>(withLookback(READ_API_ENDPOINTS.v2Hosts, lookbackDays)),
        readJson<SessionInfo[]>(withLookback(READ_API_ENDPOINTS.v2Sessions, lookbackDays)),
      ]);
      rememberReadApi("v2");
      return { hosts, sessions, source: "v2" };
    } catch (error) {
      if (!shouldFallBackToLegacy(error)) throw error;
    }
  }
  const [hosts, sessions] = await Promise.all([
    readJson<HostInfo[]>(withLookback(READ_API_ENDPOINTS.legacyHosts, lookbackDays)),
    readJson<SessionInfo[]>(withLookback(READ_API_ENDPOINTS.legacySessions, lookbackDays)),
  ]);
  rememberReadApi("legacy");
  return { hosts, sessions, source: "legacy" };
}

export async function fetchSessionEvents(sessionId: string, init?: RequestInit, lookbackDays?: number): Promise<SessionEventsPayload> {
  if (preferredReadApi !== "legacy") {
    try {
      const payload = await readJson<SessionPayload | SessionEvent[] | { session?: SessionInfo; events?: SessionEvent[] }>(
        withLookback(READ_API_ENDPOINTS.v2SessionEvents(sessionId), lookbackDays),
        init,
      );
      rememberReadApi("v2");
      return normalizeSessionEventsPayload(payload, "v2");
    } catch (error) {
      if (!shouldFallBackToLegacy(error)) throw error;
    }
  }
  const payload = await readJson<SessionPayload>(withLookback(READ_API_ENDPOINTS.legacySession(sessionId), lookbackDays), init);
  rememberReadApi("legacy");
  return normalizeSessionEventsPayload(payload, "legacy");
}

export async function fetchSyncExclusions(): Promise<SyncExclusionInfo[]> {
  const payload = await readJson<SyncExclusionsResponse>(READ_API_ENDPOINTS.syncExclusions);
  return payload.exclusions;
}

export async function createSyncExclusion(input: {
  kind: SyncExclusionKind;
  targetId: string;
  label?: string;
  metadata?: Record<string, unknown>;
}): Promise<SyncExclusionInfo> {
  return await readJson<SyncExclusionInfo>(READ_API_ENDPOINTS.syncExclusions, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function restoreSyncExclusion(id: string): Promise<SyncExclusionInfo> {
  const payload = await readJson<{ ok: true; exclusion: SyncExclusionInfo }>(READ_API_ENDPOINTS.restoreSyncExclusion(id), {
    method: "POST",
  });
  return payload.exclusion;
}

export async function pullUpdates(options: PullOptions = {}): Promise<PullResult> {
  const limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES;
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const metadataOnly = options.metadataOnly !== false;
  const lookbackDays = options.lookbackDays === undefined ? undefined : clampRetentionDays(options.lookbackDays);
  const onProgress = options.onProgress;
  const storedCursor = await getMeta<string>("syncCursor");
  let cursor = storedCursor ?? "0";
  let backfillCursor = await getMeta<string>("backfillCursor");
  let storedBackfillHasMore = await getMeta<boolean>("backfillHasMore");
  const storedLookbackDays = await getMeta<number>("lookbackDays");
  const lookbackChanged = lookbackDays !== undefined && storedLookbackDays !== lookbackDays;
  if (lookbackChanged) {
    backfillCursor = undefined;
    storedBackfillHasMore = false;
    await Promise.all([deleteMeta("metadataCursor"), deleteMeta("backfillCursor"), setMeta("backfillHasMore", false), setMeta("lookbackDays", lookbackDays)]);
  }
  const eventMode = eventModeForPull({
    metadataOnly,
    requestedEventMode: options.eventMode,
    storedCursor,
    backfillCursor,
    backfillHasMore: storedBackfillHasMore,
  });
  let metadataCursor = lookbackChanged ? undefined : await getMeta<string>("metadataCursor");
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
    const payload = await fetchBatch(previousCursor, limitBytes, timeoutMs, metadataOnly, metadataCursor, eventMode, backfillCursor, lookbackDays);
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
