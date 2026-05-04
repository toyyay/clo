import { describe, expect, test } from "bun:test";
import { makeHandlers, newV3SocketData, specHash, type V3WebSocket } from "./ws-server";
import type { ChatIndex, GroupNode, RenderItem, ServerFrame, ViewSpec } from "../../../packages/sync-v3/contracts";
import type { DeltaResult, Repo, SnapshotResult } from "./repo";

// In-memory fake repo for integration tests.
function makeFakeRepo(): Repo & { addEvent(chatId: string, item: RenderItem, seq: number): void } {
  const items: { chatId: string; item: RenderItem; seq: number; bytes: number }[] = [];
  const chatTitles = new Map<string, string>();

  return {
    addEvent(chatId, item, seq) {
      items.push({ chatId, item, seq, bytes: 200 });
      if (!chatTitles.has(chatId)) chatTitles.set(chatId, `chat ${chatId}`);
    },
    async buildSnapshot(view: ViewSpec): Promise<SnapshotResult> {
      const matched = items.filter((it) => matchesViewExcludes(view, it.chatId));
      const cursor = matched.reduce((m, it) => Math.max(m, it.seq), 0);
      const chatIds = Array.from(new Set(matched.map((it) => it.chatId)));
      const chats: ChatIndex[] = chatIds.map((cid) => ({
        chatId: cid,
        groupKey: "h:test|p:claude|pr:default",
        hostId: "test",
        provider: "claude",
        projectKey: "default",
        title: chatTitles.get(cid) ?? cid,
        lastSeenAt: "2026-05-04T00:00:00Z",
        approxBytes: 1000,
        itemCount: matched.filter((it) => it.chatId === cid).length,
      }));
      const tails: Record<string, RenderItem[]> = {};
      const tailLimit = view.history?.tailItems ?? 200;
      for (const cid of chatIds) {
        tails[cid] = matched.filter((it) => it.chatId === cid).slice(-tailLimit).map((it) => it.item);
      }
      const groups: GroupNode[] = [
        { key: "h:test", level: 1, parentKey: null, label: "test", chatCount: chatIds.length, approxBytes: 1000, lastSeenAt: "2026-05-04T00:00:00Z", topChatIds: [] },
      ];
      return { cursor, groups, chats, tails, totals: { items: matched.length, bytesRemaining: 0 } };
    },
    async fetchDelta(view: ViewSpec, since: number, _limitBytes?: number): Promise<DeltaResult> {
      const matched = items.filter((it) => matchesViewExcludes(view, it.chatId) && it.seq > since);
      matched.sort((a, b) => a.seq - b.seq);
      const out = matched.map((it) => ({ chatId: it.chatId, item: it.item, seq: it.seq }));
      const cursor = out.length ? out[out.length - 1].seq : since;
      return { cursor, items: out, bytesRemaining: 0, moreReady: false };
    },
    async fetchHistoryRange(opts) {
      const chatItems = items.filter((it) => it.chatId === opts.chatId).map((it) => it.item);
      return { items: chatItems.slice(-opts.limit), hasOlder: chatItems.length > opts.limit, hasNewer: false };
    },
    async bytesRemainingForView() {
      return 0;
    },
    async refreshGroupAggregates() {},
  };
}

function matchesViewExcludes(view: ViewSpec, chatId: string): boolean {
  if ((view.excludes ?? []).includes(chatId)) return false;
  return true;
}

function makeFakeSocket() {
  const sent: ServerFrame[] = [];
  const ws: V3WebSocket = {
    data: newV3SocketData(),
    send(msg: string) {
      sent.push(JSON.parse(msg));
      return msg.length;
    },
    close() {},
  };
  return { ws, sent };
}

const TEST_VIEW: ViewSpec = {
  id: "active",
  predicate: { host: "test" },
  history: { tailItems: 5 },
  liveTail: true,
  priority: 100,
};

const TEXT_ITEM: RenderItem = { k: "t", id: 1, p: 0, r: "u", txt: "hello" };

describe("ws-server", () => {
  test("hello returns ack and snapshots known views", async () => {
    const repo = makeFakeRepo();
    repo.addEvent("v3:1", TEXT_ITEM, 1);

    const handlers = makeHandlers({
      repo,
      async loadViews() {
        return [{ view: TEST_VIEW, cursor: 0, hash: specHash(TEST_VIEW) }];
      },
    });

    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(
      ws,
      JSON.stringify({ op: "hello", v: 1, clientId: "c1", views: [] }),
    );

    const helloOk = sent.find((f) => f.op === "hello.ok");
    expect(helloOk).toBeDefined();
    const snapshot = sent.find((f) => f.op === "view.snapshot");
    expect(snapshot).toBeDefined();
    if (snapshot && snapshot.op === "view.snapshot") {
      expect(snapshot.viewId).toBe("active");
      expect(snapshot.chats.length).toBe(1);
      expect(snapshot.tails["v3:1"]).toBeDefined();
    }
  });

  test("upsert + new event fires batch via notifyNewEvents", async () => {
    const repo = makeFakeRepo();
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "hello", v: 1, clientId: "c2", views: [] }));
    await handlers.onMessage(ws, JSON.stringify({ op: "view.upsert", view: TEST_VIEW }));

    // After upsert, snapshot is sent (empty)
    expect(sent.find((f) => f.op === "view.snapshot")).toBeDefined();

    // Simulate new event arrival
    repo.addEvent("v3:1", TEXT_ITEM, 1);
    handlers.notifyNewEvents(1);

    // Wait for microtask drain
    await Promise.resolve();
    await Promise.resolve();

    const batch = sent.find((f) => f.op === "view.batch");
    expect(batch).toBeDefined();
    if (batch && batch.op === "view.batch") {
      expect(batch.items.length).toBe(1);
      expect(batch.cursor).toBe(1);
    }
  });

  test("ack advances cursor; subsequent drain starts after acked", async () => {
    const repo = makeFakeRepo();
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "hello", v: 1, clientId: "c3", views: [] }));
    await handlers.onMessage(ws, JSON.stringify({ op: "view.upsert", view: TEST_VIEW }));

    repo.addEvent("v3:1", TEXT_ITEM, 1);
    handlers.notifyNewEvents(1);
    await Promise.resolve(); await Promise.resolve();

    expect(ws.data.acked.get("active")).toBe(0);
    await handlers.onMessage(ws, JSON.stringify({ op: "view.ack", viewId: "active", cursor: 1 }));
    expect(ws.data.acked.get("active")).toBe(1);

    // No new events, drain triggered → should send view.idle (after ack ticked)
    await Promise.resolve(); await Promise.resolve();
    const idle = sent.filter((f) => f.op === "view.idle");
    expect(idle.length).toBeGreaterThan(0);
  });

  test("history.range returns items + reqId echo", async () => {
    const repo = makeFakeRepo();
    repo.addEvent("v3:42", TEXT_ITEM, 1);
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "hello", v: 1, clientId: "c4", views: [] }));
    await handlers.onMessage(
      ws,
      JSON.stringify({ op: "history.range", reqId: "r1", chatId: "v3:42", limit: 10 }),
    );

    const reply = sent.find((f) => f.op === "history.range.ok");
    expect(reply).toBeDefined();
    if (reply && reply.op === "history.range.ok") {
      expect(reply.reqId).toBe("r1");
      expect(reply.items.length).toBe(1);
    }
  });

  test("chat.exclude removes chat from view & sends chat.removed", async () => {
    const repo = makeFakeRepo();
    repo.addEvent("v3:1", TEXT_ITEM, 1);
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "hello", v: 1, clientId: "c5", views: [] }));
    await handlers.onMessage(ws, JSON.stringify({ op: "view.upsert", view: TEST_VIEW }));
    sent.length = 0;

    await handlers.onMessage(
      ws,
      JSON.stringify({ op: "chat.exclude", viewId: "active", chatId: "v3:1" }),
    );

    const removed = sent.find((f) => f.op === "chat.removed");
    expect(removed).toBeDefined();
    if (removed && removed.op === "chat.removed") {
      expect(removed.chatId).toBe("v3:1");
      expect(removed.evictHint).toBe(true);
    }
  });

  test("ping/pong", async () => {
    const repo = makeFakeRepo();
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "ping" }));
    expect(sent.some((f) => f.op === "pong")).toBe(true);
  });

  test("specHash mismatch on hello triggers fresh snapshot", async () => {
    const repo = makeFakeRepo();
    repo.addEvent("v3:1", TEXT_ITEM, 1);
    const handlers = makeHandlers({
      repo,
      async loadViews() {
        return [{ view: TEST_VIEW, cursor: 99, hash: specHash(TEST_VIEW) }];
      },
    });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    // Client sends a stale hash
    await handlers.onMessage(
      ws,
      JSON.stringify({
        op: "hello",
        v: 1,
        clientId: "c6",
        views: [{ viewId: "active", specHash: "stalehash", cursor: 99 }],
      }),
    );
    const snap = sent.find((f) => f.op === "view.snapshot");
    expect(snap).toBeDefined();
  });

  test("close marks socket and stops draining", async () => {
    const repo = makeFakeRepo();
    const handlers = makeHandlers({ repo });
    const { ws } = makeFakeSocket();
    handlers.onOpen(ws);
    handlers.onClose(ws);
    expect(ws.data.closed).toBe(true);
    repo.addEvent("v3:1", TEXT_ITEM, 1);
    handlers.notifyNewEvents(1);
    // No throw is enough; draining is no-op when closed.
  });
});
