import { describe, expect, test } from "bun:test";
import { makeHandlers, newV3SocketData, type V3WebSocket } from "./ws-server";
import type { ServerFrame } from "../../../packages/sync-v3/contracts";
import type { Repo } from "./repo";

// In-memory fake repo for the v4 protocol. Only what `query` and `hello.ok`
// touch — the v3 snapshot/batch pieces are gone.
function makeFakeRepo(): Repo & {
  setMaxRev(n: number): void;
  setQueryRows(rows: Record<string, unknown>[]): void;
  setQueryShouldThrow(err: Error | null): void;
} {
  let maxRev = 0;
  let queryRows: Record<string, unknown>[] = [];
  let queryError: Error | null = null;
  return {
    setMaxRev(n) {
      maxRev = n;
    },
    setQueryRows(rows) {
      queryRows = rows;
    },
    setQueryShouldThrow(err) {
      queryError = err;
    },
    async runRawQuery() {
      if (queryError) throw queryError;
      return { rows: queryRows.slice(), durationMs: 1, truncated: false };
    },
    async runRawQueryWithMaxRev() {
      if (queryError) throw queryError;
      return { rows: queryRows.slice(), durationMs: 1, truncated: false, maxRev };
    },
    async fetchMaxRev() {
      return maxRev;
    },
    async refreshV4MaterializedViews() {
      return [
        { name: "v3_chat_index_full", ok: true },
        { name: "v3_chat_search", ok: true },
        { name: "v3_chat_last_render", ok: true },
      ];
    },
    async refreshGroupAggregates() {},
  };
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

describe("ws-server v4", () => {
  test("hello returns hello.ok with maxRev", async () => {
    const repo = makeFakeRepo();
    repo.setMaxRev(42);
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "hello", v: 4, clientId: "c1" }));

    const helloOk = sent.find((f) => f.op === "hello.ok");
    expect(helloOk).toBeDefined();
    if (helloOk && helloOk.op === "hello.ok") {
      expect(helloOk.v).toBe(1); // WS_PROTOCOL_VERSION constant
      expect(helloOk.maxRev).toBe(42);
      expect(typeof helloOk.serverTime).toBe("string");
    }
  });

  test("query op returns query.ok with rows + maxRev", async () => {
    const repo = makeFakeRepo();
    repo.setMaxRev(99);
    repo.setQueryRows([{ x: 1 }, { x: 2 }]);
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(
      ws,
      JSON.stringify({ op: "query", reqId: "q1", sql: "select 1 as x" }),
    );

    const ok = sent.find((f) => f.op === "query.ok");
    expect(ok).toBeDefined();
    if (ok && ok.op === "query.ok") {
      expect(ok.reqId).toBe("q1");
      expect(ok.rows.length).toBe(2);
      expect(ok.rowCount).toBe(2);
      expect(ok.maxRev).toBe(99);
      expect(ok.truncated).toBe(false);
    }
  });

  test("query failure surfaces as query.err with reason", async () => {
    const repo = makeFakeRepo();
    repo.setQueryShouldThrow(new Error("syntax error"));
    const handlers = makeHandlers({ repo });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(
      ws,
      JSON.stringify({ op: "query", reqId: "qerr", sql: "boom" }),
    );

    const err = sent.find((f) => f.op === "query.err");
    expect(err).toBeDefined();
    if (err && err.op === "query.err") {
      expect(err.reqId).toBe("qerr");
      expect(err.error).toContain("syntax error");
    }
  });

  test("ping returns pong", async () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "ping" }));
    expect(sent.find((f) => f.op === "pong")).toBeDefined();
  });

  test("broadcastTick fans out tick to every open socket", () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    handlers.onOpen(a.ws);
    handlers.onOpen(b.ws);

    handlers.broadcastTick(123, [10, 20]);

    for (const sock of [a, b]) {
      const tick = sock.sent.find((f) => f.op === "tick");
      expect(tick).toBeDefined();
      if (tick && tick.op === "tick") {
        expect(tick.maxRev).toBe(123);
        expect(tick.files).toEqual([10, 20]);
      }
    }
  });

  test("broadcastTick without files omits the field", () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    handlers.broadcastTick(456);

    const tick = sent.find((f) => f.op === "tick");
    expect(tick).toBeDefined();
    if (tick && tick.op === "tick") {
      expect(tick.maxRev).toBe(456);
      expect(tick.files).toBeUndefined();
    }
  });

  test("close removes socket from broadcast set", () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    handlers.onOpen(a.ws);
    handlers.onOpen(b.ws);
    handlers.onClose(a.ws);

    handlers.broadcastTick(1);

    expect(a.sent.find((f) => f.op === "tick")).toBeUndefined();
    expect(b.sent.find((f) => f.op === "tick")).toBeDefined();
  });

  test("unknown op is silently ignored (no crash)", async () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, JSON.stringify({ op: "no.such.op", reqId: "x" }));
    expect(sent.length).toBe(0);
  });

  test("malformed JSON is silently dropped", async () => {
    const handlers = makeHandlers({ repo: makeFakeRepo() });
    const { ws, sent } = makeFakeSocket();
    handlers.onOpen(ws);
    await handlers.onMessage(ws, "this is not json {{{");
    expect(sent.length).toBe(0);
  });
});
