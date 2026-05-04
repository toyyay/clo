// IndexedDB wrapper for sync-v3 frontend.
//
// Принципы:
//   • Никогда `getAll` на больших сторах (render_items, chats).
//   • Чтение всегда либо по primary key, либо по index cursor с лимитом.
//   • render_items keyed by [chatId, seq] → пагинация O(window).
//   • heights персистентны → нет remeasure-storm при смене чата.
//
// Схема v5:
//   meta:           { key: string; value: unknown }
//   views:          { viewId; spec; cursor; specHash; updatedAt }
//   view_chats:     [viewId, chatId] → { joinedAt; lastSeq; pinned }
//   chat_index:     chatId → { ChatIndex }
//   chats_full:     chatId → { reserved for future heavy meta }
//   render_items:   [chatId, seq] → RenderItem
//   heights:        [chatId, itemKey] → number
//   groups:         groupKey → GroupNode
//   mutation_outbox: id → { op; createdAt }

import type { ChatIndex, GroupNode, RenderItem } from "../../packages/sync-v3/contracts";

const DB_NAME = "chatview-v3";
// v2: adds the `exclude_rules` store used by the v4 protocol store. Old stores
// untouched — onupgradeneeded only creates the new one.
const DB_VERSION = 2;

/** Legacy v3 view-row shape. Kept as a freeform record so existing rows
 *  (written by the v3 store) round-trip cleanly through bulk-IDB getters
 *  even though the v4 store ignores them. The store / index.html migration
 *  to drop the `views` / `view_chats` IDB stores happens in DB_VERSION 3. */
export type ViewRow = {
  viewId: string;
  spec: unknown;
  cursor: number;
  specHash: string;
  updatedAt: string;
};

export type ViewChatRow = {
  viewId: string;
  chatId: string;
  joinedAt: string;
  lastSeq: number;
  pinned: boolean;
};

export type RenderItemRow = {
  chatId: string;
  seq: number;
  itemKey: string;       // "id:p" — используется для измерений высоты
  item: RenderItem;
  bytes: number;
};

export type HeightRow = {
  chatId: string;
  itemKey: string;
  h: number;
};

export type MutationRow = {
  id: string;
  op: unknown;
  createdAt: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("views")) {
        db.createObjectStore("views", { keyPath: "viewId" });
      }
      if (!db.objectStoreNames.contains("view_chats")) {
        const s = db.createObjectStore("view_chats", { keyPath: ["viewId", "chatId"] });
        s.createIndex("byView", "viewId");
        s.createIndex("byViewLastSeq", ["viewId", "lastSeq"]);
      }
      if (!db.objectStoreNames.contains("chat_index")) {
        const s = db.createObjectStore("chat_index", { keyPath: "chatId" });
        s.createIndex("byGroupLastSeen", ["groupKey", "lastSeenAt"]);
        s.createIndex("byHostLastSeen", ["hostId", "lastSeenAt"]);
        s.createIndex("byProjectLastSeen", ["projectKey", "lastSeenAt"]);
      }
      if (!db.objectStoreNames.contains("render_items")) {
        db.createObjectStore("render_items", { keyPath: ["chatId", "seq"] });
      }
      if (!db.objectStoreNames.contains("heights")) {
        db.createObjectStore("heights", { keyPath: ["chatId", "itemKey"] });
      }
      if (!db.objectStoreNames.contains("groups")) {
        const s = db.createObjectStore("groups", { keyPath: "key" });
        s.createIndex("byParentLastSeen", ["parentKey", "lastSeenAt"]);
        s.createIndex("byLevel", "level");
      }
      if (!db.objectStoreNames.contains("mutation_outbox")) {
        db.createObjectStore("mutation_outbox", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("exclude_rules")) {
        // Auto-incrementing primary key — rule shapes vary by `type` and the
        // user just wants to add/remove rows; no natural unique key.
        db.createObjectStore("exclude_rules", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  });
  return dbPromise;
}

// ---------- low-level helpers ---------------------------------------------

function awaitReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function awaitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
  });
}

// ---------- meta ----------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const row = await awaitReq(db.transaction("meta").objectStore("meta").get(key));
  return (row as { key: string; value: T } | undefined)?.value;
}

export async function setMeta<T>(key: string, value: T) {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key, value });
  await awaitTx(tx);
}

// ---------- views ---------------------------------------------------------

export async function listViews(): Promise<ViewRow[]> {
  const db = await openDb();
  return awaitReq(db.transaction("views").objectStore("views").getAll() as IDBRequest<ViewRow[]>);
}

export async function upsertView(row: ViewRow) {
  const db = await openDb();
  const tx = db.transaction("views", "readwrite");
  tx.objectStore("views").put(row);
  await awaitTx(tx);
}

export async function deleteView(viewId: string) {
  const db = await openDb();
  const tx = db.transaction(["views", "view_chats"], "readwrite");
  tx.objectStore("views").delete(viewId);
  // remove view_chats entries for this view
  const idx = tx.objectStore("view_chats").index("byView");
  await new Promise<void>((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(viewId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      tx.objectStore("view_chats").delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  await awaitTx(tx);
}

// ---------- chat_index ----------------------------------------------------

export async function getChatIndex(chatId: string): Promise<ChatIndex | undefined> {
  const db = await openDb();
  return awaitReq(db.transaction("chat_index").objectStore("chat_index").get(chatId) as IDBRequest<ChatIndex | undefined>);
}

export async function getChatIndexMany(chatIds: string[]): Promise<ChatIndex[]> {
  if (!chatIds.length) return [];
  const db = await openDb();
  const store = db.transaction("chat_index").objectStore("chat_index");
  const out = await Promise.all(
    chatIds.map((id) => awaitReq(store.get(id) as IDBRequest<ChatIndex | undefined>)),
  );
  return out.filter((c): c is ChatIndex => Boolean(c));
}

/** Page chats inside a group ordered by lastSeenAt DESC, after a watermark. */
export async function getChatsByGroup(
  groupKey: string,
  opts: { afterLastSeenAt?: string; limit: number },
): Promise<ChatIndex[]> {
  const db = await openDb();
  const idx = db.transaction("chat_index").objectStore("chat_index").index("byGroupLastSeen");
  const range = opts.afterLastSeenAt
    ? IDBKeyRange.bound([groupKey, ""], [groupKey, opts.afterLastSeenAt], false, true)
    : IDBKeyRange.bound([groupKey, ""], [groupKey, "￿"]);

  return new Promise((resolve, reject) => {
    const acc: ChatIndex[] = [];
    const req = idx.openCursor(range, "prev");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || acc.length >= opts.limit) return resolve(acc);
      acc.push(cursor.value as ChatIndex);
      cursor.continue();
    };
  });
}

export async function bulkPutChatIndex(rows: ChatIndex[]) {
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction("chat_index", "readwrite");
  for (const row of rows) tx.objectStore("chat_index").put(row);
  await awaitTx(tx);
}

export async function deleteChatIndex(chatId: string) {
  const db = await openDb();
  const tx = db.transaction("chat_index", "readwrite");
  tx.objectStore("chat_index").delete(chatId);
  await awaitTx(tx);
}

// ---------- render_items --------------------------------------------------

export async function bulkPutRenderItems(rows: RenderItemRow[]) {
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction("render_items", "readwrite");
  for (const row of rows) tx.objectStore("render_items").put(row);
  await awaitTx(tx);
}

/** Last N items for a chat (by seq DESC, return chronological asc). */
export async function getChatTail(chatId: string, limit: number): Promise<RenderItemRow[]> {
  const db = await openDb();
  const store = db.transaction("render_items").objectStore("render_items");
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  return new Promise((resolve, reject) => {
    const acc: RenderItemRow[] = [];
    const req = store.openCursor(range, "prev");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || acc.length >= limit) return resolve(acc.reverse());
      acc.push(cursor.value as RenderItemRow);
      cursor.continue();
    };
  });
}

export async function getChatRange(
  chatId: string,
  opts: { fromSeq: number; toSeq: number; limit?: number; direction?: "prev" | "next" },
): Promise<RenderItemRow[]> {
  const db = await openDb();
  const store = db.transaction("render_items").objectStore("render_items");
  const range = IDBKeyRange.bound([chatId, opts.fromSeq], [chatId, opts.toSeq]);
  const direction = opts.direction ?? "next";
  return new Promise((resolve, reject) => {
    const acc: RenderItemRow[] = [];
    const req = store.openCursor(range, direction);
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || acc.length >= limit) {
        return resolve(direction === "prev" ? acc.reverse() : acc);
      }
      acc.push(cursor.value as RenderItemRow);
      cursor.continue();
    };
  });
}

export async function deleteChatItems(chatId: string) {
  const db = await openDb();
  const tx = db.transaction("render_items", "readwrite");
  const store = tx.objectStore("render_items");
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  await awaitTx(tx);
}

// ---------- heights -------------------------------------------------------

export async function getHeightsForChat(chatId: string): Promise<Map<string, number>> {
  const db = await openDb();
  const store = db.transaction("heights").objectStore("heights");
  const range = IDBKeyRange.bound([chatId, ""], [chatId, "￿"]);
  return new Promise((resolve, reject) => {
    const out = new Map<string, number>();
    const req = store.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      const row = cursor.value as HeightRow;
      out.set(row.itemKey, row.h);
      cursor.continue();
    };
  });
}

export async function bulkPutHeights(rows: HeightRow[]) {
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction("heights", "readwrite");
  for (const row of rows) tx.objectStore("heights").put(row);
  await awaitTx(tx);
}

// ---------- groups --------------------------------------------------------

export async function bulkPutGroups(rows: GroupNode[]) {
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction("groups", "readwrite");
  for (const row of rows) tx.objectStore("groups").put(row);
  await awaitTx(tx);
}

export async function getGroupsByLevel(level: 1 | 2 | 3): Promise<GroupNode[]> {
  const db = await openDb();
  const idx = db.transaction("groups").objectStore("groups").index("byLevel");
  return awaitReq(idx.getAll(IDBKeyRange.only(level)) as IDBRequest<GroupNode[]>);
}

export async function getGroupsByParent(parentKey: string): Promise<GroupNode[]> {
  const db = await openDb();
  const idx = db.transaction("groups").objectStore("groups").index("byParentLastSeen");
  const range = IDBKeyRange.bound([parentKey, ""], [parentKey, "￿"]);
  return new Promise((resolve, reject) => {
    const acc: GroupNode[] = [];
    const req = idx.openCursor(range, "prev");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(acc);
      acc.push(cursor.value as GroupNode);
      cursor.continue();
    };
  });
}

export async function getGroup(groupKey: string): Promise<GroupNode | undefined> {
  const db = await openDb();
  return awaitReq(db.transaction("groups").objectStore("groups").get(groupKey) as IDBRequest<GroupNode | undefined>);
}

// ---------- mutation outbox ----------------------------------------------

export async function enqueueMutation(op: unknown) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const db = await openDb();
  const tx = db.transaction("mutation_outbox", "readwrite");
  tx.objectStore("mutation_outbox").put({ id, op, createdAt: new Date().toISOString() } satisfies MutationRow);
  await awaitTx(tx);
  return id;
}

export async function listMutations(): Promise<MutationRow[]> {
  const db = await openDb();
  return awaitReq(db.transaction("mutation_outbox").objectStore("mutation_outbox").getAll() as IDBRequest<MutationRow[]>);
}

export async function deleteMutations(ids: string[]) {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction("mutation_outbox", "readwrite");
  for (const id of ids) tx.objectStore("mutation_outbox").delete(id);
  await awaitTx(tx);
}

// ---------- exclude rules (v4) --------------------------------------------

export type ExcludeRuleType = "host" | "project" | "provider" | "chatId" | "kind" | "maxItemBytes";

export type ExcludeRuleRow = {
  /** Auto-assigned by IDB (autoIncrement). Optional on insert. */
  id?: number;
  type: ExcludeRuleType;
  /** Strings for {host,project,provider,chatId,kind}; numbers for maxItemBytes. */
  value: string | number;
  addedAt: string;
};

export async function addExcludeRule(rule: Omit<ExcludeRuleRow, "id">): Promise<number> {
  const db = await openDb();
  const tx = db.transaction("exclude_rules", "readwrite");
  const req = tx.objectStore("exclude_rules").add(rule);
  const id = (await awaitReq(req)) as number;
  await awaitTx(tx);
  return id;
}

export async function removeExcludeRule(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("exclude_rules", "readwrite");
  tx.objectStore("exclude_rules").delete(id);
  await awaitTx(tx);
}

export async function listExcludeRules(): Promise<ExcludeRuleRow[]> {
  const db = await openDb();
  return awaitReq(
    db.transaction("exclude_rules").objectStore("exclude_rules").getAll() as IDBRequest<ExcludeRuleRow[]>,
  );
}

// ---------- helpers --------------------------------------------------------

export function itemKey(item: RenderItem): string {
  switch (item.k) {
    case "tg":
      return `tg:${item.uses[0]?.id ?? "x"}-${item.uses[0]?.p ?? 0}`;
    default:
      return `${item.k}:${(item as { id: number }).id}-${(item as { p: number }).p}`;
  }
}
