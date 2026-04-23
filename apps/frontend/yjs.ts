import * as Y from "yjs";
import type { SessionInfo, YjsSocketMessage, YjsSyncRequest, YjsSyncResponse } from "../../packages/shared/types";
import { loadYDocUpdate, saveYDocUpdate } from "./db";

export function docIdForSession(sessionDbId: string) {
  return `chat:${sessionDbId}`;
}

export function getDraftMap(doc: Y.Doc) {
  return doc.getMap("state");
}

export function getDraft(doc: Y.Doc) {
  return String(getDraftMap(doc).get("draft") ?? "");
}

export function setDraft(doc: Y.Doc, value: string, origin = "local") {
  const map = getDraftMap(doc);
  doc.transact(() => {
    map.set("draft", value);
  }, origin);
}

export async function loadDraftDoc(docId: string) {
  const doc = new Y.Doc();
  const cached = await loadYDocUpdate(docId);
  if (cached?.update) Y.applyUpdate(doc, fromBase64(cached.update), "cache");
  return doc;
}

export async function persistDraftDoc(docId: string, doc: Y.Doc) {
  await saveYDocUpdate(docId, toBase64(Y.encodeStateAsUpdate(doc)));
}

export async function mergeCachedDraftUpdate(docId: string, update: Uint8Array) {
  const cached = await loadYDocUpdate(docId);
  const updates = [];
  if (cached?.update) updates.push(fromBase64(cached.update));
  updates.push(update);
  await saveYDocUpdate(docId, toBase64(Y.mergeUpdates(updates)));
}

export async function syncDraftDoc(docId: string, sessionDbId: string, doc: Y.Doc, includeUpdate: boolean) {
  const request: YjsSyncRequest = {
    docs: [
      {
        docId,
        sessionDbId,
        stateVector: toBase64(Y.encodeStateVector(doc)),
        update: includeUpdate ? toBase64(Y.encodeStateAsUpdate(doc)) : undefined,
      },
    ],
  };
  const response = await postYjsSync(request);
  const remote = response.docs.find((item) => item.docId === docId);
  if (remote?.update) Y.applyUpdate(doc, fromBase64(remote.update), "remote");
  await persistDraftDoc(docId, doc);
}

export async function syncCachedDraftDocs(sessions: SessionInfo[]) {
  const docs = await Promise.all(
    sessions.map(async (session) => {
      const docId = docIdForSession(session.id);
      const cached = await loadYDocUpdate(docId);
      const updateBytes = cached?.update ? fromBase64(cached.update) : null;
      return {
        docId,
        sessionDbId: session.id,
        stateVector: updateBytes ? toBase64(Y.encodeStateVectorFromUpdate(updateBytes)) : toBase64(Y.encodeStateVector(new Y.Doc())),
        update: cached?.update,
      };
    }),
  );
  if (!docs.length) return;

  const response = await postYjsSync({ docs });
  await Promise.all(
    response.docs.map(async (remote) => {
      if (!remote.update) return;
      await mergeCachedDraftUpdate(remote.docId, fromBase64(remote.update));
    }),
  );
}

export function openYjsSocket(onRemoteUpdate: (docId: string, update: Uint8Array) => void) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/yjs/ws`);

  socket.addEventListener("message", (event) => {
    let message: YjsSocketMessage;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "update") onRemoteUpdate(message.docId, fromBase64(message.update));
  });

  return socket;
}

export function subscribeYjsSocket(socket: WebSocket | null, docIds: string[]) {
  sendWhenOpen(socket, { type: "subscribe", docIds } satisfies YjsSocketMessage);
}

export function sendYjsSocketUpdate(socket: WebSocket | null, docId: string, sessionDbId: string, update: Uint8Array) {
  sendWhenOpen(socket, {
    type: "update",
    docId,
    sessionDbId,
    update: toBase64(update),
  } satisfies YjsSocketMessage);
}

function sendWhenOpen(socket: WebSocket | null, message: YjsSocketMessage) {
  if (!socket) return;
  const send = () => socket.send(JSON.stringify(message));
  if (socket.readyState === WebSocket.OPEN) send();
  else if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener("open", send, { once: true });
}

async function postYjsSync(request: YjsSyncRequest): Promise<YjsSyncResponse> {
  const response = await fetch("/api/yjs/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`yjs sync failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function toBase64(update: Uint8Array) {
  let binary = "";
  for (let i = 0; i < update.length; i += 1) binary += String.fromCharCode(update[i]);
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
