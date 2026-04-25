import { openCacheDb } from "./db";

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
