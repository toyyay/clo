import type { HostInfo, SessionEvent, SessionInfo, SessionPayload, SyncResponse } from "../../packages/shared/types";

const DB_NAME = "chatview-cache";
const DB_VERSION = 4;

type StoreName =
  | "meta"
  | "hosts"
  | "sessions"
  | "events"
  | "ydocs"
  | "audioRecordings"
  | "audioChunks"
  | "clientLogs";

export type CachedYDoc = {
  docId: string;
  update: string;
  updatedAt: string;
};

export type CacheStats = {
  indexedDb: Record<StoreName, number>;
  storageUsageBytes?: number;
  storageQuotaBytes?: number;
  cacheNames: string[];
  serviceWorkers: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openCacheDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

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
      }
      if (!db.objectStoreNames.contains("ydocs")) db.createObjectStore("ydocs", { keyPath: "docId" });
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
      dbPromise = null;
      reject(new Error("IndexedDB upgrade is blocked by another open tab"));
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
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

export async function loadHosts(): Promise<HostInfo[]> {
  const db = await openCacheDb();
  const hosts = await request<HostInfo[]>(db.transaction("hosts").objectStore("hosts").getAll());
  return hosts.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function loadSessions(): Promise<SessionInfo[]> {
  const db = await openCacheDb();
  const sessions = await request<SessionInfo[]>(db.transaction("sessions").objectStore("sessions").getAll());
  return sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function loadSessionEvents(sessionDbId: string): Promise<SessionEvent[]> {
  const db = await openCacheDb();
  const index = db.transaction("events").objectStore("events").index("sessionDbId");
  const events = await request<SessionEvent[]>(index.getAll(IDBKeyRange.only(sessionDbId)));
  return events.sort((a, b) => a.lineNo - b.lineNo);
}

export async function applySync(
  payload: SyncResponse,
  options: { pruneMissing?: "none" | "full-shell"; replaceShell?: boolean; storeEventCursor?: boolean } = {},
) {
  const db = await openCacheDb();
  const tx = db.transaction(["meta", "hosts", "sessions", "events"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const meta = tx.objectStore("meta");
  const liveHostIds = new Set(payload.hosts.map((host) => host.agentId));
  const liveSessionIds = new Set(payload.sessions.filter((session) => !session.deletedAt).map((session) => session.id));

  for (const host of payload.hosts) hosts.put(host);
  for (const session of payload.sessions) {
    if (session.deletedAt) {
      sessions.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    } else {
      sessions.put(session);
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
        queueDeleteEventsForSession(events, session.id);
      }
      cursor.continue();
    };
  }
  for (const event of payload.events) events.put(event);
  if (options.storeEventCursor !== false) meta.put({ key: "syncCursor", value: payload.cursor });
  if (payload.metadataCursor) meta.put({ key: "metadataCursor", value: payload.metadataCursor });
  meta.put({ key: "lastSyncAt", value: new Date().toISOString() });

  await transactionDone(tx);
}

export async function cacheShell(hostsInput: HostInfo[], sessionsInput: SessionInfo[], options: { authoritative?: boolean } = {}) {
  const db = await openCacheDb();
  const tx = db.transaction(["hosts", "sessions", "events"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const liveHostIds = new Set(hostsInput.map((host) => host.agentId));
  const liveSessionIds = new Set(sessionsInput.filter((session) => !session.deletedAt).map((session) => session.id));
  for (const host of hostsInput) hosts.put(host);
  for (const session of sessionsInput) {
    if (session.deletedAt) {
      sessions.delete(session.id);
      queueDeleteEventsForSession(events, session.id);
    } else {
      sessions.put(session);
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
        queueDeleteEventsForSession(events, session.id);
      }
      cursor.continue();
    };
  }
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
  const db = await openCacheDb();
  const deleteTx = db.transaction("events", "readwrite");
  queueDeleteEventsForSession(deleteTx.objectStore("events"), payload.session.id);
  await transactionDone(deleteTx);

  const tx = db.transaction(["sessions", "events"] satisfies StoreName[], "readwrite");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  sessions.put(payload.session);
  for (const event of payload.events) events.put(event);
  await transactionDone(tx);
}

export async function loadYDocUpdate(docId: string): Promise<CachedYDoc | undefined> {
  const db = await openCacheDb();
  return request<CachedYDoc | undefined>(db.transaction("ydocs").objectStore("ydocs").get(docId));
}

export async function saveYDocUpdate(docId: string, update: string) {
  const db = await openCacheDb();
  const tx = db.transaction("ydocs", "readwrite");
  tx.objectStore("ydocs").put({ docId, update, updatedAt: new Date().toISOString() } satisfies CachedYDoc);
  await transactionDone(tx);
}

export async function loadCacheStats(): Promise<CacheStats> {
  const db = await openCacheDb();
  const storeNames: StoreName[] = [
    "meta",
    "hosts",
    "sessions",
    "events",
    "ydocs",
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
  const cacheNames = "caches" in window ? await caches.keys().catch(() => []) : [];
  const registrations = navigator.serviceWorker?.getRegistrations
    ? await navigator.serviceWorker.getRegistrations().catch(() => [])
    : [];

  return {
    indexedDb,
    storageUsageBytes: estimate.usage,
    storageQuotaBytes: estimate.quota,
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
  await Promise.all(names.map((name) => caches.delete(name)));
  return names.length;
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

function queueDeleteEventsForSession(events: IDBObjectStore, sessionId: string) {
  const existing = events.index("sessionDbId").openKeyCursor(IDBKeyRange.only(sessionId));
  existing.onsuccess = () => {
    const cursor = existing.result;
    if (!cursor) return;
    events.delete(cursor.primaryKey);
    cursor.continue();
  };
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}
