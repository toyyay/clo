// Reactive store for sync-v3 frontend.
//
// Держит:
//   • currentViews: Map<viewId, ViewSpec>
//   • cursors:      Map<viewId, number>
//   • snapshotsApplied: per-view флаги
//   • status: ConnStatus от ws-client
//   • visibleChats: Map<chatId, ChatIndex>  (только то что отдано sidebar)
//   • activeChat: chatId | null
//   • activeWindow: { items, firstSeq, lastSeq, hasOlder, hasNewer }
//
// Использует useSyncExternalStore-friendly API (subscribe + getSnapshot).
// IDB запись делает прозрачно при применении ServerFrame.

import type {
  ChatIndex,
  ClientFrame,
  ClientViewState,
  GroupNode,
  RenderItem,
  SeqRenderItem,
  ServerFrame,
  ViewSpec,
} from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { createWsClient, specHash, type ConnStatus, type WsClient } from "./ws-client";

export type ActiveChatWindow = {
  chatId: string;
  items: RenderItem[];
  /** sync_revision of the oldest item currently in window */
  firstSeq: number;
  /** sync_revision of the newest item currently in window */
  lastSeq: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

export type StoreState = {
  status: ConnStatus;
  views: Map<string, ViewSpec>;
  cursors: Map<string, number>;
  pendingBytes: Map<string, number>;
  groups: Map<string, GroupNode>;
  visibleChats: Map<string, ChatIndex>;
  activeChat: string | null;
  activeWindow: ActiveChatWindow | null;
};

export type Store = {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  start(opts: { url: string; clientId: string }): Promise<void>;
  stop(): void;

  // user actions
  upsertView(view: ViewSpec): Promise<void>;
  deleteView(viewId: string): Promise<void>;
  excludeChat(viewId: string, chatId: string): Promise<void>;
  includeChat(viewId: string, chatId: string): Promise<void>;
  openChat(chatId: string, tailLimit?: number): Promise<void>;
  closeActiveChat(): void;
  loadOlder(limit?: number): Promise<void>;
  loadGroupChildren(parentKey: string): Promise<GroupNode[]>;
  loadChatPage(groupKey: string, opts: { afterLastSeenAt?: string; limit: number }): Promise<ChatIndex[]>;
};

const TAIL_DEFAULT = 200;
const HISTORY_PAGE = 100;

export function createStore(): Store {
  const listeners = new Set<() => void>();
  let state: StoreState = {
    status: { kind: "idle" },
    views: new Map(),
    cursors: new Map(),
    pendingBytes: new Map(),
    groups: new Map(),
    visibleChats: new Map(),
    activeChat: null,
    activeWindow: null,
  };

  let ws: WsClient | null = null;
  /** map reqId → resolver for pending history.range */
  const historyRequests = new Map<string, (frame: { items: SeqRenderItem[]; hasOlder: boolean; hasNewer: boolean }) => void>();

  function commit(next: Partial<StoreState>) {
    state = { ...state, ...next };
    for (const l of listeners) l();
  }

  function ackView(viewId: string, cursor: number) {
    ws?.send({ op: "view.ack", viewId, cursor });
    state.cursors.set(viewId, cursor);
    commit({ cursors: new Map(state.cursors) });
  }

  async function applySnapshot(frame: Extract<ServerFrame, { op: "view.snapshot" }>) {
    // Persist groups, chats, tails into IDB. Server gives us real sync_revision
    // values as seq, so older items returned via history.range later land at
    // the same key and overlap correctly.
    await idb.bulkPutGroups(frame.groups);
    await idb.bulkPutChatIndex(frame.chats);
    const itemRows: idb.RenderItemRow[] = [];
    for (const [chatId, tail] of Object.entries(frame.tails)) {
      for (const entry of tail) {
        itemRows.push({
          chatId,
          seq: entry.seq,
          itemKey: idb.itemKey(entry.item),
          item: entry.item,
          bytes: estimateBytes(entry.item),
        });
      }
    }
    await idb.bulkPutRenderItems(itemRows);

    // Update reactive state
    const groups = new Map(state.groups);
    for (const g of frame.groups) groups.set(g.key, g);
    const visibleChats = new Map(state.visibleChats);
    for (const c of frame.chats) visibleChats.set(c.chatId, c);
    state.cursors.set(frame.viewId, frame.cursor);
    state.pendingBytes.set(frame.viewId, frame.totals.bytesRemaining);
    commit({ groups, visibleChats, cursors: new Map(state.cursors), pendingBytes: new Map(state.pendingBytes) });

    ackView(frame.viewId, frame.cursor);
  }

  async function applyBatch(frame: Extract<ServerFrame, { op: "view.batch" }>) {
    const itemRows: idb.RenderItemRow[] = frame.items.map((bi) => ({
      chatId: bi.chatId,
      seq: bi.seq,
      itemKey: idb.itemKey(bi.item),
      item: bi.item,
      bytes: estimateBytes(bi.item),
    }));
    await idb.bulkPutRenderItems(itemRows);

    // Also: if active chat received new items, append into the active window.
    if (state.activeChat) {
      const fresh = frame.items.filter((bi) => bi.chatId === state.activeChat);
      if (fresh.length && state.activeWindow) {
        const merged = [...state.activeWindow.items, ...fresh.map((f) => f.item)];
        const lastSeq = fresh[fresh.length - 1]!.seq;
        commit({
          activeWindow: {
            ...state.activeWindow,
            items: merged,
            lastSeq,
            hasNewer: false,
          },
        });
      }
    }

    state.cursors.set(frame.viewId, frame.cursor);
    state.pendingBytes.set(frame.viewId, frame.bytesRemaining);
    commit({ cursors: new Map(state.cursors), pendingBytes: new Map(state.pendingBytes) });

    ackView(frame.viewId, frame.cursor);
  }

  async function applyChatRemoved(frame: Extract<ServerFrame, { op: "chat.removed" }>) {
    await idb.deleteChatIndex(frame.chatId);
    if (frame.evictHint) await idb.deleteChatItems(frame.chatId);
    const visibleChats = new Map(state.visibleChats);
    visibleChats.delete(frame.chatId);
    commit({
      visibleChats,
      activeChat: state.activeChat === frame.chatId ? null : state.activeChat,
      activeWindow: state.activeChat === frame.chatId ? null : state.activeWindow,
    });
  }

  async function applyChatAdded(frame: Extract<ServerFrame, { op: "chat.added" }>) {
    await idb.bulkPutChatIndex([frame.chat]);
    const itemRows: idb.RenderItemRow[] = frame.tail.map((entry) => ({
      chatId: frame.chat.chatId,
      seq: entry.seq,
      itemKey: idb.itemKey(entry.item),
      item: entry.item,
      bytes: estimateBytes(entry.item),
    }));
    await idb.bulkPutRenderItems(itemRows);
    const visibleChats = new Map(state.visibleChats);
    visibleChats.set(frame.chat.chatId, frame.chat);
    commit({ visibleChats });
  }

  function applyHistoryReply(frame: Extract<ServerFrame, { op: "history.range.ok" }>) {
    const cb = historyRequests.get(frame.reqId);
    if (cb) {
      cb({ items: frame.items, hasOlder: frame.hasOlder, hasNewer: frame.hasNewer });
      historyRequests.delete(frame.reqId);
    }
  }

  function onFrame(frame: ServerFrame) {
    switch (frame.op) {
      case "hello.ok":
        return;
      case "view.snapshot":
        void applySnapshot(frame);
        return;
      case "view.batch":
        void applyBatch(frame);
        return;
      case "view.idle":
        state.pendingBytes.set(frame.viewId, 0);
        commit({ pendingBytes: new Map(state.pendingBytes) });
        return;
      case "chat.removed":
        void applyChatRemoved(frame);
        return;
      case "chat.added":
        void applyChatAdded(frame);
        return;
      case "history.range.ok":
        applyHistoryReply(frame);
        return;
      case "evict.suggest":
        // honor server eviction suggestion
        for (const id of frame.chatIds) void idb.deleteChatItems(id);
        return;
      case "view.error":
        console.warn(`[sync-v3] view error ${frame.viewId}: ${frame.reason}`);
        return;
    }
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start(opts) {
      // Hydrate from IDB first (offline-first paint)
      const [storedViews, allGroups] = await Promise.all([idb.listViews(), Promise.resolve()]);
      const views = new Map<string, ViewSpec>();
      const cursors = new Map<string, number>();
      for (const row of storedViews) {
        views.set(row.viewId, row.spec);
        cursors.set(row.viewId, row.cursor);
      }
      const level1 = await idb.getGroupsByLevel(1);
      const groups = new Map<string, GroupNode>();
      for (const g of level1) groups.set(g.key, g);
      commit({ views, cursors, groups });

      ws = createWsClient({
        url: opts.url,
        clientId: opts.clientId,
        onStatus: (s) => commit({ status: s }),
        onFrame,
        async getViewStates(): Promise<ClientViewState[]> {
          const rows = await idb.listViews();
          return rows.map((r) => ({ viewId: r.viewId, specHash: r.specHash, cursor: r.cursor }));
        },
        async drainOutbox(): Promise<ClientFrame[]> {
          const rows = await idb.listMutations();
          await idb.deleteMutations(rows.map((r) => r.id));
          return rows.map((r) => r.op as ClientFrame);
        },
      });
      ws.start();
    },

    stop() {
      ws?.stop();
      ws = null;
    },

    async upsertView(view) {
      const hash = await specHash(view);
      await idb.upsertView({
        viewId: view.id,
        spec: view,
        cursor: state.cursors.get(view.id) ?? 0,
        specHash: hash,
        updatedAt: new Date().toISOString(),
      });
      const views = new Map(state.views);
      views.set(view.id, view);
      commit({ views });
      const frame: ClientFrame = { op: "view.upsert", view };
      if (ws && state.status.kind === "open") ws.send(frame);
      else await idb.enqueueMutation(frame);
    },

    async deleteView(viewId) {
      await idb.deleteView(viewId);
      const views = new Map(state.views);
      views.delete(viewId);
      const cursors = new Map(state.cursors);
      cursors.delete(viewId);
      commit({ views, cursors });
      const frame: ClientFrame = { op: "view.delete", viewId };
      if (ws && state.status.kind === "open") ws.send(frame);
      else await idb.enqueueMutation(frame);
    },

    async excludeChat(viewId, chatId) {
      const frame: ClientFrame = { op: "chat.exclude", viewId, chatId };
      if (ws && state.status.kind === "open") ws.send(frame);
      else await idb.enqueueMutation(frame);
    },

    async includeChat(viewId, chatId) {
      const frame: ClientFrame = { op: "chat.include", viewId, chatId };
      if (ws && state.status.kind === "open") ws.send(frame);
      else await idb.enqueueMutation(frame);
    },

    async openChat(chatId, tailLimit = TAIL_DEFAULT) {
      // 1. IDB сначала — мгновенный first-frame для офлайна и быстрого старта.
      let tailRows = await idb.getChatTail(chatId, tailLimit);

      // 2. Если IDB пуст для этого чата (snapshot теперь не возит tails),
      //    тянем с сервера через history.range и кэшируем в IDB.
      if (tailRows.length === 0 && ws && state.status.kind === "open") {
        try {
          const reply = await requestHistory(ws, historyRequests, {
            chatId,
            limit: tailLimit,
          });
          if (reply.items.length) {
            const itemRows: idb.RenderItemRow[] = reply.items.map((entry) => ({
              chatId,
              seq: entry.seq,
              itemKey: idb.itemKey(entry.item),
              item: entry.item,
              bytes: estimateBytes(entry.item),
            }));
            await idb.bulkPutRenderItems(itemRows);
            tailRows = itemRows.map((r) => ({ chatId: r.chatId, seq: r.seq, itemKey: r.itemKey, item: r.item, bytes: r.bytes }));
          }
        } catch (err) {
          console.warn("[sync-v3] openChat: history.range failed", err);
        }
      }

      const window: ActiveChatWindow = {
        chatId,
        items: tailRows.map((r) => r.item),
        firstSeq: tailRows[0]?.seq ?? 0,
        lastSeq: tailRows[tailRows.length - 1]?.seq ?? 0,
        hasOlder: tailRows.length === tailLimit,
        hasNewer: false,
      };
      commit({ activeChat: chatId, activeWindow: window });
    },

    closeActiveChat() {
      commit({ activeChat: null, activeWindow: null });
    },

    async loadOlder(limit = HISTORY_PAGE) {
      const w = state.activeWindow;
      if (!w || !w.hasOlder) return;
      // Try IDB first
      const fromIdb = await idb.getChatRange(w.chatId, {
        fromSeq: 0,
        toSeq: w.firstSeq - 1,
        limit,
        direction: "prev",
      });
      let items = fromIdb.map((r) => r.item);
      let firstSeq = fromIdb[0]?.seq ?? w.firstSeq;
      let hasOlder = fromIdb.length === limit;

      // If IDB ran out, ask server. Server returns SeqRenderItem with real seqs.
      if (fromIdb.length < limit && ws && state.status.kind === "open") {
        const remaining = limit - fromIdb.length;
        const serverReply = await requestHistory(ws, historyRequests, {
          chatId: w.chatId,
          before: firstSeq, // ask before whatever we already have
          limit: remaining,
        });
        const itemRows: idb.RenderItemRow[] = serverReply.items.map((entry) => ({
          chatId: w.chatId,
          seq: entry.seq,
          itemKey: idb.itemKey(entry.item),
          item: entry.item,
          bytes: estimateBytes(entry.item),
        }));
        await idb.bulkPutRenderItems(itemRows);
        items = [...serverReply.items.map((e) => e.item), ...items];
        firstSeq = serverReply.items[0]?.seq ?? firstSeq;
        hasOlder = serverReply.hasOlder;
      }

      commit({
        activeWindow: {
          ...w,
          items: [...items, ...w.items],
          firstSeq,
          hasOlder,
        },
      });
    },

    async loadGroupChildren(parentKey) {
      return idb.getGroupsByParent(parentKey);
    },

    async loadChatPage(groupKey, opts) {
      return idb.getChatsByGroup(groupKey, opts);
    },
  };
}

function estimateBytes(item: RenderItem): number {
  try {
    return new TextEncoder().encode(JSON.stringify(item)).byteLength;
  } catch {
    return 0;
  }
}

function requestHistory(
  ws: WsClient,
  pending: Map<string, (frame: { items: SeqRenderItem[]; hasOlder: boolean; hasNewer: boolean }) => void>,
  opts: { chatId: string; before?: number; after?: number; limit: number },
): Promise<{ items: SeqRenderItem[]; hasOlder: boolean; hasNewer: boolean }> {
  return new Promise((resolve, reject) => {
    const reqId = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("history.range timeout"));
    }, 15_000);
    pending.set(reqId, (frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    ws.send({ op: "history.range", reqId, ...opts });
  });
}
