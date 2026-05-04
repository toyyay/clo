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
import { createWsClient, specHash, type ConnStatus, type WsClient, type WsLink } from "./ws-client";

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
  /** Chat the user clicked on but whose tail hasn't loaded yet. Used to show
   *  skeleton placeholders instead of an empty area. */
  loadingChat: string | null;
  /** True while loadOlder is in flight for the active chat. Drives the
   *  "loading earlier messages…" pill above the virtual list so the user
   *  can tell "thinking" from "nothing more". */
  loadingOlder: boolean;
  /** Live WS link metrics — see ws-client WsLink. */
  link: WsLink;
  /** Last per-view ack progress, used to estimate throughput. */
  lastBatchAt: Map<string, number>;
  /** Rolling estimate of bytes/sec downloaded across all views. */
  throughputBps: number;
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

// Rolling window for throughput estimation.
const THROUGHPUT_WINDOW_MS = 30_000;

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
    loadingChat: null,
    loadingOlder: false,
    link: { pingRttMs: null, pingMeasuredAt: null, lastFrameAt: null, lastSentAt: null, bytesIn: 0, bytesOut: 0 },
    lastBatchAt: new Map(),
    throughputBps: 0,
  };
  /** Track recent (timestamp, bytesIn) samples for throughput calculation. */
  const throughputSamples: { t: number; bytes: number }[] = [];

  let ws: WsClient | null = null;
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Increments on every openChat / closeActiveChat. Async paths check this
   *  before mutating state so a stale request can't pollute the new chat. */
  let activeChatToken = 0;
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
    state.lastBatchAt.set(frame.viewId, Date.now());
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
        onFrame: (frame) => {
          // Update link.bytesIn-derived throughput on every frame.
          const wsLink = ws?.link();
          if (wsLink) {
            const now = Date.now();
            throughputSamples.push({ t: now, bytes: wsLink.bytesIn });
            // Drop samples older than the window.
            while (throughputSamples.length && throughputSamples[0]!.t < now - THROUGHPUT_WINDOW_MS) {
              throughputSamples.shift();
            }
            let bps = 0;
            if (throughputSamples.length >= 2) {
              const first = throughputSamples[0]!;
              const last = throughputSamples[throughputSamples.length - 1]!;
              const dtSec = Math.max(0.001, (last.t - first.t) / 1000);
              bps = Math.max(0, (last.bytes - first.bytes) / dtSec);
            }
            state.link = wsLink;
            state.throughputBps = bps;
          }
          onFrame(frame);
          commit({});
        },
        async getViewStates(): Promise<ClientViewState[]> {
          const rows = await idb.listViews();
          return rows.map((r) => ({ viewId: r.viewId, specHash: r.specHash, cursor: r.cursor }));
        },
        async drainOutbox(): Promise<ClientFrame[]> {
          // 1. Existing offline mutations (excludes/includes/upserts queued offline).
          const rows = await idb.listMutations();
          await idb.deleteMutations(rows.map((r) => r.id));
          const queued: ClientFrame[] = rows.map((r) => r.op as ClientFrame);

          // 2. Self-healing reconnect: always re-upsert every view we have in
          //    IDB. Server's persistView is idempotent (INSERT ... ON CONFLICT
          //    DO UPDATE), so this is safe + ensures client_views and the
          //    client's IDB state stay in sync — fixes the case where server
          //    knows the cursor but lost the spec (or it was never persisted).
          //    Cost: one upsert per view per reconnect (typically 1-3).
          const storedViews = await idb.listViews();
          for (const row of storedViews) {
            // Skip if outbox already has an upsert for this view — avoid duplicates.
            if (queued.some((f) => f.op === "view.upsert" && f.view.id === row.viewId)) continue;
            queued.push({ op: "view.upsert", view: row.spec });
          }
          return queued;
        },
      });
      ws.start();
      ws.subscribeLink(() => {
        const cur = ws?.link();
        if (cur) {
          state.link = cur;
          commit({});
        }
      });
      // Tick once per second so "last frame N seconds ago" stays fresh.
      tickHandle = setInterval(() => commit({}), 1000);
    },

    stop() {
      ws?.stop();
      ws = null;
      if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
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
      // Each openChat invocation gets a fresh token; if the user opens
      // another chat (or closes this one) before our async work finishes,
      // we silently drop the result instead of polluting the next chat.
      const token = ++activeChatToken;
      // Show skeleton immediately — even before IDB read returns.
      commit({ loadingChat: chatId, activeChat: null, activeWindow: null });

      // 1. IDB сначала — мгновенный first-frame для офлайна и быстрого старта.
      let tailRows = await idb.getChatTail(chatId, tailLimit);
      if (token !== activeChatToken) return;

      // 2. Если IDB пуст для этого чата (snapshot теперь не возит tails),
      //    тянем с сервера через history.range и кэшируем в IDB.
      if (tailRows.length === 0 && ws && state.status.kind === "open") {
        try {
          const reply = await requestHistory(ws, historyRequests, {
            chatId,
            limit: tailLimit,
          });
          if (token !== activeChatToken) return; // user moved on
          if (reply.items.length) {
            const itemRows: idb.RenderItemRow[] = reply.items.map((entry) => ({
              chatId,
              seq: entry.seq,
              itemKey: idb.itemKey(entry.item),
              item: entry.item,
              bytes: estimateBytes(entry.item),
            }));
            await idb.bulkPutRenderItems(itemRows);
            if (token !== activeChatToken) return;
            tailRows = itemRows.map((r) => ({ chatId: r.chatId, seq: r.seq, itemKey: r.itemKey, item: r.item, bytes: r.bytes }));
          }
        } catch (err) {
          if (token !== activeChatToken) return;
          console.warn("[sync-v3] openChat: history.range failed", err);
        }
      }

      if (token !== activeChatToken) return;
      const window: ActiveChatWindow = {
        chatId,
        items: tailRows.map((r) => r.item),
        firstSeq: tailRows[0]?.seq ?? 0,
        lastSeq: tailRows[tailRows.length - 1]?.seq ?? 0,
        hasOlder: tailRows.length === tailLimit,
        hasNewer: false,
      };
      commit({ activeChat: chatId, activeWindow: window, loadingChat: null });
    },

    closeActiveChat() {
      activeChatToken += 1;
      commit({ activeChat: null, activeWindow: null, loadingChat: null });
    },

    async loadOlder(limit = HISTORY_PAGE) {
      const w = state.activeWindow;
      if (!w || !w.hasOlder) return;
      if (state.loadingOlder) return; // already loading — don't fan out
      const tokenAtStart = activeChatToken;
      const chatIdAtStart = w.chatId;
      commit({ loadingOlder: true });

      try {
        const fromIdb = await idb.getChatRange(chatIdAtStart, {
          fromSeq: 0,
          toSeq: w.firstSeq - 1,
          limit,
          direction: "prev",
        });
        // If user switched chats while we were reading IDB, abort.
        if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;

        let items = fromIdb.map((r) => r.item);
        let firstSeq = fromIdb[0]?.seq ?? w.firstSeq;
        let hasOlder = fromIdb.length === limit;

        if (fromIdb.length < limit && ws && state.status.kind === "open") {
          const remaining = limit - fromIdb.length;
          const serverReply = await requestHistory(ws, historyRequests, {
            chatId: chatIdAtStart,
            before: firstSeq,
            limit: remaining,
          });
          if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
          const itemRows: idb.RenderItemRow[] = serverReply.items.map((entry) => ({
            chatId: chatIdAtStart,
            seq: entry.seq,
            itemKey: idb.itemKey(entry.item),
            item: entry.item,
            bytes: estimateBytes(entry.item),
          }));
          await idb.bulkPutRenderItems(itemRows);
          if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
          items = [...serverReply.items.map((e) => e.item), ...items];
          firstSeq = serverReply.items[0]?.seq ?? firstSeq;
          hasOlder = serverReply.hasOlder;
        }

        // Final guard before commit.
        if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
        const stillCurrent = state.activeWindow;
        if (!stillCurrent || stillCurrent.chatId !== chatIdAtStart) return;
        commit({
          activeWindow: {
            ...stillCurrent,
            items: [...items, ...stillCurrent.items],
            firstSeq,
            hasOlder,
          },
        });
      } finally {
        // Always clear, even if we early-returned because the user switched chats.
        commit({ loadingOlder: false });
      }
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
