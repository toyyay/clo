import type { HostInfo, SessionEvent, SessionInfo, SessionPayload, SyncExclusionInfo, SyncResponse } from "../../packages/shared/types";

const DB_NAME = "chatview-cache-v3";
const DB_VERSION = 4;
const CURRENT_SESSION_PREFIX = "v3:";
const DB_OPEN_TIMEOUT_MS = 4000;
const EVENT_ORDER_INDEX = "sessionOrder";
const EVENT_ORDER_MAX = Number.MAX_SAFE_INTEGER;

type StoreName =
  | "meta"
  | "hosts"
  | "sessions"
  | "events"
  | "mutedSources"
  | "sessionStats"
  | "ydocs"
  | "yjsOutbox"
  | "audioRecordings"
  | "audioChunks"
  | "clientLogs";

export type CachedYDoc = {
  docId: string;
  sessionDbId?: string;
  update: string;
  updatedAt: string;
  dirty?: boolean;
  lastSyncAt?: string;
  lastSyncError?: string | null;
};

export type QueuedYjsUpdate = {
  id: string;
  docId: string;
  sessionDbId: string;
  update: string;
  createdAt: string;
};

export type CacheStats = {
  indexedDb: Record<StoreName, number>;
  storageUsageBytes?: number;
  storageQuotaBytes?: number;
  storagePersisted?: boolean;
  cacheNames: string[];
  serviceWorkers: number;
};

export type SessionCacheStat = {
  sessionId: string;
  agentId: string;
  hostname: string;
  sourceProvider?: string | null;
  projectKey: string;
  approxBytes: number;
  eventCount: number;
  updatedAt: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openCacheDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      reject(new Error("IndexedDB open timed out"));
    }, DB_OPEN_TIMEOUT_MS);

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      dbPromise = null;
      reject(error);
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("hosts")) db.createObjectStore("hosts", { keyPath: "agentId" });
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("agentId", "agentId");
        sessions.createIndex("lastSeenAt", "lastSeenAt");
      }
      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("sessionDbId", "sessionDbId");
        events.createIndex(EVENT_ORDER_INDEX, ["sessionDbId", "lineNo", "offset", "id"]);
      } else {
        const tx = request.transaction;
        const events = tx?.objectStore("events");
        if (events && !events.indexNames.contains(EVENT_ORDER_INDEX)) {
          events.createIndex(EVENT_ORDER_INDEX, ["sessionDbId", "lineNo", "offset", "id"]);
        }
      }
      if (!db.objectStoreNames.contains("mutedSources")) db.createObjectStore("mutedSources", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessionStats")) {
        const stats = db.createObjectStore("sessionStats", { keyPath: "sessionId" });
        stats.createIndex("agentId", "agentId");
        stats.createIndex("sourceProvider", "sourceProvider");
      }
      if (!db.objectStoreNames.contains("ydocs")) db.createObjectStore("ydocs", { keyPath: "docId" });
      if (!db.objectStoreNames.contains("yjsOutbox")) {
        const outbox = db.createObjectStore("yjsOutbox", { keyPath: "id" });
        outbox.createIndex("createdAt", "createdAt");
        outbox.createIndex("docId", "docId");
      }
      if (!db.objectStoreNames.contains("audioRecordings")) {
        const recordings = db.createObjectStore("audioRecordings", { keyPath: "id" });
        recordings.createIndex("status", "status");
        recordings.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("audioChunks")) {
        const chunks = db.createObjectStore("audioChunks", { keyPath: "id" });
        chunks.createIndex("recordingId", "recordingId");
      }
      if (!db.objectStoreNames.contains("clientLogs")) {
        const logs = db.createObjectStore("clientLogs", { keyPath: "id" });
        logs.createIndex("createdAt", "createdAt");
        logs.createIndex("level", "level");
      }
    };

    request.onblocked = () => {
      fail(new Error("IndexedDB upgrade is blocked by another open tab"));
    };
    request.onerror = () => {
      fail(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  });
  return dbPromise;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openCacheDb();
  const row = await request<{ key: string; value: T } | undefined>(db.transaction("meta").objectStore("meta").get(key));
  return row?.value;
}

export async function setMeta<T>(key: string, value: T) {
  const db = await openCacheDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key, value });
  await transactionDone(tx);
}

export async function deleteMeta(key: string) {
  const db = await openCacheDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").delete(key);
  await transactionDone(tx);
}

export async function loadHosts(): Promise<HostInfo[]> {
  const db = await openCacheDb();
  const hosts = await request<HostInfo[]>(db.transaction("hosts").objectStore("hosts").getAll());
  return hosts.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function loadSessions(): Promise<SessionInfo[]> {
  const db = await openCacheDb();
  const sessions = await request<SessionInfo[]>(db.transaction("sessions").objectStore("sessions").getAll());
  return sessions
    .filter((session) => isCurrentSessionId(session.id))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function loadRecentSessionEvents(sessionDbId: string, limit: number): Promise<SessionEvent[]> {
  if (!isCurrentSessionId(sessionDbId)) return [];
  return readSessionEventPage(sessionDbId, { direction: "prev", limit });
}

export async function loadSessionEventsBefore(sessionDbId: string, cursor: SessionEvent, limit: number): Promise<SessionEvent[]> {
  if (!isCurrentSessionId(sessionDbId)) return [];
  return readSessionEventPage(sessionDbId, {
    direction: "prev",
    limit,
    range: IDBKeyRange.bound(minEventOrderKey(sessionDbId), eventOrderKey(cursor), false, true),
  });
}

export async function loadSessionEventsAfter(sessionDbId: string, cursor: SessionEvent, limit: number): Promise<SessionEvent[]> {
  if (!isCurrentSessionId(sessionDbId)) return [];
  return readSessionEventPage(sessionDbId, {
    direction: "next",
    limit,
    range: IDBKeyRange.bound(eventOrderKey(cursor), maxEventOrderKey(sessionDbId), true, false),
  });
}

export async function loadMutedSources(): Promise<SyncExclusionInfo[]> {
  const db = await openCacheDb();
  const rows = await request<SyncExclusionInfo[]>(db.transaction("mutedSources").objectStore("mutedSources").getAll());
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cacheMutedSources(exclusions: SyncExclusionInfo[]) {
  const db = await openCacheDb();
  const tx = db.transaction("mutedSources", "readwrite");
  const store = tx.objectStore("mutedSources");
  store.clear();
  for (const exclusion of exclusions) {
    if (!exclusion.restoredAt) store.put(exclusion);
  }
  await transactionDone(tx);
}

export async function loadSessionStats(): Promise<SessionCacheStat[]> {
  const db = await openCacheDb();
  return request<SessionCacheStat[]>(db.transaction("sessionStats").objectStore("sessionStats").getAll());
}

async function readSessionEventPage(
  sessionDbId: string,
  options: {
    direction: IDBCursorDirection;
    limit: number;
    range?: IDBKeyRange;
  },
) {
  const limit = Math.max(0, Math.floor(options.limit));
  if (!limit) return [];
  const db = await openCacheDb();
  const tx = db.transaction("events");
  const index = tx.objectStore("events").index(EVENT_ORDER_INDEX);
  const range = options.range ?? IDBKeyRange.bound(minEventOrderKey(sessionDbId), maxEventOrderKey(sessionDbId));
  const events = await collectCursor<SessionEvent>(index.openCursor(range, options.direction), limit);
  return options.direction === "prev" ? events.reverse() : events;
}

function minEventOrderKey(sessionDbId: string): [string, number, number, string] {
  return [sessionDbId, 0, 0, ""];
}

function maxEventOrderKey(sessionDbId: string): [string, number, number, string] {
  return [sessionDbId, EVENT_ORDER_MAX, EVENT_ORDER_MAX, "\uffff"];
}

function eventOrderKey(event: SessionEvent): [string, number, number, string] {
  return [event.sessionDbId, event.lineNo, event.offset, event.id];
}

export async function applySync(
  payload: SyncResponse,
  options: { pruneMissing?: "none" | "full-shell"; replaceShell?: boolean; storeEventCursor?: boolean } = {},
) {
  const db = await openCacheDb();
  const tx = db.transaction(["meta", "hosts", "sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const meta = tx.objectStore("meta");
  const stats = tx.objectStore("sessionStats");
  const currentSessions = payload.sessions.filter((session) => isCurrentSessionId(session.id));
  const eventsBySessionId = groupEventsBySession(payload.events);
  if (payload.sessions.length !== currentSessions.length) {
    warnLegacyFiltered("applySync.sessions", payload.sessions.length - currentSessions.length, payload.sessions[0]?.id);
  }
  const liveHostIds = new Set(payload.hosts.map((host) => host.agentId));
  const liveSessionIds = new Set(currentSessions.filter((session) => !session.deletedAt).map((session) => session.id));

  for (const host of payload.hosts) hosts.put(host);
  for (const session of currentSessions) {
    if (session.deletedAt) {
      sessions.delete(session.id);
      stats.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    } else {
      sessions.put(session);
      queuePutSessionStat(stats, session, eventsBySessionId.get(session.id) ?? []);
    }
  }
  const shouldPruneMissing = options.pruneMissing === "full-shell" || options.replaceShell === true;
  if (shouldPruneMissing) {
    queueDeleteMissingHosts(hosts, liveHostIds);
    const cursorReq = sessions.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const session = cursor.value as SessionInfo;
      if (!liveSessionIds.has(session.id)) {
        sessions.delete(cursor.primaryKey);
        stats.delete(session.id);
        queueDeleteEventsForSession(events, session.id);
      }
      cursor.continue();
    };
  }
  for (const event of payload.events) {
    if (isCurrentSessionId(event.sessionDbId)) events.put(event);
  }
  if (options.storeEventCursor !== false) meta.put({ key: "syncCursor", value: payload.cursor });
  if (payload.backfillCursor) meta.put({ key: "backfillCursor", value: payload.backfillCursor });
  if (payload.backfillCursor || payload.backfillHasMore !== undefined) {
    meta.put({ key: "backfillHasMore", value: payload.backfillHasMore === true });
  }
  if (payload.metadataCursor) meta.put({ key: "metadataCursor", value: payload.metadataCursor });
  meta.put({ key: "lastSyncAt", value: new Date().toISOString() });

  await transactionDone(tx);
}

export async function cacheShell(hostsInput: HostInfo[], sessionsInput: SessionInfo[], options: { authoritative?: boolean } = {}) {
  const db = await openCacheDb();
  const tx = db.transaction(["hosts", "sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const stats = tx.objectStore("sessionStats");
  const currentSessions = sessionsInput.filter((session) => isCurrentSessionId(session.id));
  const liveHostIds = new Set(hostsInput.map((host) => host.agentId));
  const liveSessionIds = new Set(currentSessions.filter((session) => !session.deletedAt).map((session) => session.id));
  for (const host of hostsInput) hosts.put(host);
  for (const session of currentSessions) {
    if (session.deletedAt) {
      sessions.delete(session.id);
      stats.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    } else {
      sessions.put(session);
      queuePutSessionStat(stats, session);
    }
  }
  if (options.authoritative !== false) {
    queueDeleteMissingHosts(hosts, liveHostIds);
    const cursorReq = sessions.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const session = cursor.value as SessionInfo;
      if (!liveSessionIds.has(session.id)) {
        sessions.delete(cursor.primaryKey);
        stats.delete(session.id);
        queueDeleteEventsForSession(events, session.id);
      }
      cursor.continue();
    };
  }
  await transactionDone(tx);
}

export async function pruneCacheBefore(cutoffIso: string) {
  const cutoffTime = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffTime)) return;
  const db = await openCacheDb();
  const tx = db.transaction(["sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const stats = tx.objectStore("sessionStats");

  const sessionCursor = sessions.openCursor();
  sessionCursor.onsuccess = () => {
    const cursor = sessionCursor.result;
    if (!cursor) return;
    const session = cursor.value as SessionInfo;
    if (Date.parse(session.lastSeenAt) < cutoffTime) {
      sessions.delete(cursor.primaryKey);
      stats.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    }
    cursor.continue();
  };

  const eventCursor = events.openCursor();
  eventCursor.onsuccess = () => {
    const cursor = eventCursor.result;
    if (!cursor) return;
    const event = cursor.value as SessionEvent;
    const eventTime = Date.parse(event.createdAt ?? event.ingestedAt);
    if (Number.isFinite(eventTime) && eventTime < cutoffTime) events.delete(cursor.primaryKey);
    cursor.continue();
  };

  await transactionDone(tx);
}

export async function pruneMutedSources(exclusions: SyncExclusionInfo[]) {
  if (!exclusions.length) return;
  const db = await openCacheDb();
  const tx = db.transaction(["hosts", "sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const stats = tx.objectStore("sessionStats");
  const shouldPrune = mutedMatcher(exclusions);

  const hostCursor = hosts.openCursor();
  hostCursor.onsuccess = () => {
    const cursor = hostCursor.result;
    if (!cursor) return;
    const host = cursor.value as HostInfo;
    if (exclusions.some((exclusion) => exclusion.kind === "device" && exclusion.targetId === host.agentId)) hosts.delete(cursor.primaryKey);
    cursor.continue();
  };

  const sessionCursor = sessions.openCursor();
  sessionCursor.onsuccess = () => {
    const cursor = sessionCursor.result;
    if (!cursor) return;
    const session = cursor.value as SessionInfo;
    if (shouldPrune(session)) {
      sessions.delete(cursor.primaryKey);
      stats.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    }
    cursor.continue();
  };

  await transactionDone(tx);
}

function queueDeleteMissingHosts(hosts: IDBObjectStore, liveHostIds: Set<string>) {
  const cursorReq = hosts.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    const host = cursor.value as HostInfo;
    if (!liveHostIds.has(host.agentId)) hosts.delete(cursor.primaryKey);
    cursor.continue();
  };
}

export async function cacheSessionPayload(payload: SessionPayload) {
  if (!isCurrentSessionId(payload.session.id)) return;
  const db = await openCacheDb();
  const tx = db.transaction(["sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const stats = tx.objectStore("sessionStats");
  queueDeleteEventsForSession(events, payload.session.id);
  sessions.put(payload.session);
  for (const event of payload.events) events.put(event);
  queuePutSessionStat(stats, payload.session, payload.events);
  await transactionDone(tx);
}

export async function cacheSessionEventPage(payload: SessionPayload) {
  if (!isCurrentSessionId(payload.session.id)) return;
  const db = await openCacheDb();
  const tx = db.transaction(["sessions", "events", "sessionStats"] satisfies StoreName[], "readwrite");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const stats = tx.objectStore("sessionStats");
  sessions.put(payload.session);
  for (const event of payload.events) events.put(event);
  queuePutSessionStat(stats, payload.session);
  await transactionDone(tx);
}

function isCurrentSessionId(id: string) {
  return id.startsWith(CURRENT_SESSION_PREFIX);
}

let lastLegacyWarnAt = 0;
function warnLegacyFiltered(scope: string, count: number, sampleId: string | undefined) {
  if (count <= 0) return;
  const now = Date.now();
  if (now - lastLegacyWarnAt < 30_000) return;
  lastLegacyWarnAt = now;
  console.warn(`[chatview] dropped ${count} non-${CURRENT_SESSION_PREFIX} session ids in ${scope}`, { sampleId });
}

export async function loadYDocUpdate(docId: string): Promise<CachedYDoc | undefined> {
  const db = await openCacheDb();
  return request<CachedYDoc | undefined>(db.transaction("ydocs").objectStore("ydocs").get(docId));
}

export async function saveYDocUpdate(
  docId: string,
  update: string,
  options: { sessionDbId?: string; dirty?: boolean; lastSyncAt?: string; lastSyncError?: string | null } = {},
) {
  const db = await openCacheDb();
  const tx = db.transaction("ydocs", "readwrite");
  const store = tx.objectStore("ydocs");
  const current = await request<CachedYDoc | undefined>(store.get(docId));
  store.put({
    ...current,
    docId,
    sessionDbId: options.sessionDbId ?? current?.sessionDbId,
    update,
    updatedAt: new Date().toISOString(),
    dirty: options.dirty ?? current?.dirty ?? false,
    lastSyncAt: options.lastSyncAt ?? current?.lastSyncAt,
    lastSyncError: options.lastSyncError === undefined ? current?.lastSyncError : options.lastSyncError,
  } satisfies CachedYDoc);
  await transactionDone(tx);
}

export async function markYDocDirty(docId: string, sessionDbId: string, update?: string) {
  const db = await openCacheDb();
  const tx = db.transaction("ydocs", "readwrite");
  const store = tx.objectStore("ydocs");
  const current = await request<CachedYDoc | undefined>(store.get(docId));
  store.put({
    ...current,
    docId,
    sessionDbId,
    update: update ?? current?.update ?? "",
    updatedAt: new Date().toISOString(),
    dirty: true,
    lastSyncError: null,
  } satisfies CachedYDoc);
  await transactionDone(tx);
}

export async function listDirtyYDocs(limit = 100): Promise<CachedYDoc[]> {
  const db = await openCacheDb();
  const docs = await request<CachedYDoc[]>(db.transaction("ydocs").objectStore("ydocs").getAll());
  return docs
    .filter((doc) => doc.dirty && doc.update && doc.sessionDbId)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, Math.max(1, limit));
}

export async function enqueueYjsOutboxUpdate(input: { docId: string; sessionDbId: string; update: string }) {
  const db = await openCacheDb();
  const tx = db.transaction("yjsOutbox", "readwrite");
  const row: QueuedYjsUpdate = {
    id: newQueueId(),
    docId: input.docId,
    sessionDbId: input.sessionDbId,
    update: input.update,
    createdAt: new Date().toISOString(),
  };
  tx.objectStore("yjsOutbox").put(row);
  await transactionDone(tx);
  return row;
}

export async function loadYjsOutboxUpdates(limit = 100): Promise<QueuedYjsUpdate[]> {
  const db = await openCacheDb();
  const index = db.transaction("yjsOutbox").objectStore("yjsOutbox").index("createdAt");
  return new Promise((resolve, reject) => {
    const rows: QueuedYjsUpdate[] = [];
    const cursorRequest = index.openCursor();
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as QueuedYjsUpdate);
      cursor.continue();
    };
  });
}

export async function deleteYjsOutboxUpdates(ids: string[]) {
  if (!ids.length) return;
  const db = await openCacheDb();
  const tx = db.transaction("yjsOutbox", "readwrite");
  const outbox = tx.objectStore("yjsOutbox");
  for (const id of ids) outbox.delete(id);
  await transactionDone(tx);
}

export async function loadCacheStats(): Promise<CacheStats> {
  const db = await openCacheDb();
  const storeNames: StoreName[] = [
    "meta",
    "hosts",
    "sessions",
    "events",
    "mutedSources",
    "sessionStats",
    "ydocs",
    "yjsOutbox",
    "audioRecordings",
    "audioChunks",
    "clientLogs",
  ];
  const indexedDb = Object.fromEntries(
    await Promise.all(
      storeNames.map(async (name) => [name, await request<number>(db.transaction(name).objectStore(name).count())] as const),
    ),
  ) as Record<StoreName, number>;
  const estimate: StorageEstimate = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => ({})) : {};
  const storagePersisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => undefined) : undefined;
  const cacheNames = "caches" in window ? await caches.keys().catch(() => []) : [];
  const registrations = navigator.serviceWorker?.getRegistrations
    ? await navigator.serviceWorker.getRegistrations().catch(() => [])
    : [];

  return {
    indexedDb,
    storageUsageBytes: estimate.usage,
    storageQuotaBytes: estimate.quota,
    storagePersisted,
    cacheNames,
    serviceWorkers: registrations.length,
  };
}

export async function resetIndexedDbCache() {
  const db = await openCacheDb();
  db.close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onerror = () => reject(deleteRequest.error);
    deleteRequest.onblocked = () => reject(new Error("IndexedDB deletion is blocked by another open tab"));
    deleteRequest.onsuccess = () => resolve();
  });
}

export async function clearBrowserCaches() {
  if (!("caches" in window)) return 0;
  const names = await caches.keys();
  const chatviewNames = names.filter((name) => name.startsWith("chatview-"));
  await Promise.all(chatviewNames.map((name) => caches.delete(name)));
  return chatviewNames.length;
}

export async function unregisterServiceWorkers() {
  if (!navigator.serviceWorker?.getRegistrations) return 0;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const results = await Promise.all(registrations.map((registration) => registration.unregister()));
  return results.filter(Boolean).length;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function collectCursor<T>(cursorRequest: IDBRequest<IDBCursorWithValue | null>, limit: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as T);
      cursor.continue();
    };
  });
}

function newQueueId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function queueDeleteEventsForSession(events: IDBObjectStore, sessionId: string) {
  const existing = events.index("sessionDbId").openKeyCursor(IDBKeyRange.only(sessionId));
  existing.onsuccess = () => {
    const cursor = existing.result;
    if (!cursor) return;
    events.delete(cursor.primaryKey);
    cursor.continue();
  };
}

function groupEventsBySession(events: SessionEvent[]) {
  const bySession = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const bucket = bySession.get(event.sessionDbId);
    if (bucket) bucket.push(event);
    else bySession.set(event.sessionDbId, [event]);
  }
  return bySession;
}

function queuePutSessionStat(stats: IDBObjectStore, session: SessionInfo, events: SessionEvent[] = []) {
  stats.put({
    sessionId: session.id,
    agentId: session.agentId,
    hostname: session.hostname,
    sourceProvider: session.sourceProvider ?? null,
    projectKey: session.projectKey,
    approxBytes: estimateSessionBytes(session, events),
    eventCount: Math.max(session.eventCount, events.length),
    updatedAt: new Date().toISOString(),
  } satisfies SessionCacheStat);
}

function estimateSessionBytes(session: SessionInfo, events: SessionEvent[]) {
  let bytes = byteSize(JSON.stringify(session));
  for (const event of events) bytes += byteSize(JSON.stringify(event));
  if (!events.length) bytes += Math.max(0, session.sizeBytes || 0);
  return bytes;
}

function mutedMatcher(exclusions: SyncExclusionInfo[]) {
  const deviceIds = new Set(exclusions.filter((exclusion) => exclusion.kind === "device").map((exclusion) => exclusion.targetId));
  const providerKeys = new Set(exclusions.filter((exclusion) => exclusion.kind === "provider").map((exclusion) => exclusion.targetId));
  const sessionIds = new Set(exclusions.filter((exclusion) => exclusion.kind === "session").map((exclusion) => exclusion.targetId));
  return (session: SessionInfo) => {
    const provider = session.sourceProvider || (session.id.startsWith(CURRENT_SESSION_PREFIX) ? "v3" : "claude");
    return deviceIds.has(session.agentId) || providerKeys.has(`${session.agentId}:${provider}`) || sessionIds.has(session.id);
  };
}

function byteSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}
