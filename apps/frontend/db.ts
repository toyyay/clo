import type { HostInfo, SessionEvent, SessionInfo, SyncResponse } from "../../packages/shared/types";

const DB_NAME = "chatview-cache";
const DB_VERSION = 3;

type StoreName = "meta" | "hosts" | "sessions" | "events" | "ydocs" | "audioRecordings" | "audioChunks";

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

export type CachedAudioStatus = "recording" | "pending" | "uploading" | "failed";

export type CachedAudioRecording = {
  id: string;
  filename: string;
  mimeType: string;
  status: CachedAudioStatus;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  chunkCount: number;
  uploadAttempts: number;
  error?: string | null;
};

type CachedAudioChunk = {
  id: string;
  recordingId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  createdAt: string;
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
  for (const session of payload.sessions) {
    if (session.deletedAt) {
      sessions.delete(session.id);
      const eventIndex = events.index("sessionDbId");
      const cursorReq = eventIndex.openKeyCursor(IDBKeyRange.only(session.id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        events.delete(cursor.primaryKey);
        cursor.continue();
      };
    } else {
      sessions.put(session);
    }
  }
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

export async function loadCacheStats(): Promise<CacheStats> {
  const db = await openCacheDb();
  const storeNames: StoreName[] = ["meta", "hosts", "sessions", "events", "ydocs", "audioRecordings", "audioChunks"];
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

export async function createCachedAudioRecording(mimeType: string): Promise<CachedAudioRecording> {
  const now = new Date().toISOString();
  const id = `rec_${Date.now()}_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const recording: CachedAudioRecording = {
    id,
    filename: `recording-${now.replace(/[:.]/g, "-")}.${audioExtensionForMime(mimeType)}`,
    mimeType,
    status: "recording",
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    chunkCount: 0,
    uploadAttempts: 0,
    error: null,
  };
  const db = await openCacheDb();
  const tx = db.transaction("audioRecordings", "readwrite");
  tx.objectStore("audioRecordings").put(recording);
  await transactionDone(tx);
  return recording;
}

export async function appendCachedAudioChunk(recordingId: string, index: number, blob: Blob, durationMs: number) {
  const now = new Date().toISOString();
  const db = await openCacheDb();
  const chunkTx = db.transaction("audioChunks", "readwrite");
  chunkTx.objectStore("audioChunks").put({
    id: `${recordingId}:${String(index).padStart(8, "0")}`,
    recordingId,
    index,
    blob,
    mimeType: blob.type,
    createdAt: now,
  } satisfies CachedAudioChunk);
  await transactionDone(chunkTx);

  const recording = await loadCachedAudioRecording(recordingId);
  if (!recording) return;
  await saveCachedAudioRecording({
    ...recording,
    durationMs: Math.max(recording.durationMs, durationMs),
    chunkCount: Math.max(recording.chunkCount, index + 1),
    updatedAt: now,
    error: null,
  });
}

export async function finalizeCachedAudioRecording(recordingId: string, durationMs: number) {
  const recording = await loadCachedAudioRecording(recordingId);
  if (!recording) return;
  await saveCachedAudioRecording({
    ...recording,
    status: "pending",
    durationMs: Math.max(recording.durationMs, durationMs),
    updatedAt: new Date().toISOString(),
    error: null,
  });
}

export async function markCachedAudioRecordingStatus(recordingId: string, status: CachedAudioStatus, error?: string | null) {
  const recording = await loadCachedAudioRecording(recordingId);
  if (!recording) return;
  await saveCachedAudioRecording({
    ...recording,
    status,
    updatedAt: new Date().toISOString(),
    uploadAttempts: status === "uploading" ? recording.uploadAttempts + 1 : recording.uploadAttempts,
    error: error ?? null,
  });
}

export async function loadCachedAudioRecordings(): Promise<CachedAudioRecording[]> {
  const db = await openCacheDb();
  const rows = await request<CachedAudioRecording[]>(
    db.transaction("audioRecordings").objectStore("audioRecordings").getAll(),
  );
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function loadCachedAudioRecording(recordingId: string): Promise<CachedAudioRecording | undefined> {
  const db = await openCacheDb();
  return request<CachedAudioRecording | undefined>(
    db.transaction("audioRecordings").objectStore("audioRecordings").get(recordingId),
  );
}

export async function loadCachedAudioBlob(recordingId: string): Promise<Blob> {
  const db = await openCacheDb();
  const index = db.transaction("audioChunks").objectStore("audioChunks").index("recordingId");
  const chunks = await request<CachedAudioChunk[]>(index.getAll(IDBKeyRange.only(recordingId)));
  const ordered = chunks.sort((a, b) => a.index - b.index);
  if (!ordered.length) throw new Error("cached recording has no audio chunks");
  const recording = await loadCachedAudioRecording(recordingId);
  return new Blob(ordered.map((chunk) => chunk.blob), {
    type: recording?.mimeType || ordered[0]?.mimeType || "audio/webm",
  });
}

export async function deleteCachedAudioRecording(recordingId: string) {
  const db = await openCacheDb();
  const tx = db.transaction(["audioRecordings", "audioChunks"], "readwrite");
  tx.objectStore("audioRecordings").delete(recordingId);
  const chunkIndex = tx.objectStore("audioChunks").index("recordingId");
  const cursorReq = chunkIndex.openKeyCursor(IDBKeyRange.only(recordingId));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore("audioChunks").delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(tx);
}

async function saveCachedAudioRecording(recording: CachedAudioRecording) {
  const db = await openCacheDb();
  const tx = db.transaction("audioRecordings", "readwrite");
  tx.objectStore("audioRecordings").put(recording);
  await transactionDone(tx);
}

function audioExtensionForMime(mimeType: string) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
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
