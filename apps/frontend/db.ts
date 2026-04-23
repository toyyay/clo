import type { HostInfo, SessionEvent, SessionInfo, SyncResponse } from "../../packages/shared/types";

const DB_NAME = "chatview-cache";
const DB_VERSION = 2;

type StoreName = "meta" | "hosts" | "sessions" | "events" | "ydocs";

export type CachedYDoc = {
  docId: string;
  update: string;
  updatedAt: string;
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
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
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

export async function applySync(payload: SyncResponse) {
  const db = await openCacheDb();
  const tx = db.transaction(["meta", "hosts", "sessions", "events"] satisfies StoreName[], "readwrite");
  const hosts = tx.objectStore("hosts");
  const sessions = tx.objectStore("sessions");
  const events = tx.objectStore("events");
  const meta = tx.objectStore("meta");

  for (const host of payload.hosts) hosts.put(host);
  for (const session of payload.sessions) sessions.put(session);
  for (const event of payload.events) events.put(event);
  meta.put({ key: "syncCursor", value: payload.cursor });
  meta.put({ key: "lastSyncAt", value: new Date().toISOString() });

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
