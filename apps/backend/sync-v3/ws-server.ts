// WebSocket server for sync-v4.
//
// Two responsibilities only:
//   1. Reply to `query` / `query.run` (raw read-only SQL with statement_timeout
//      and a row cap). Every reply carries the maxRev visible to the read
//      transaction so the client's tick-tracker can race-safely decide
//      whether a re-pull is needed.
//   2. Broadcast `tick` frames to all connected sockets when ingest writes
//      new render rows. Tick is fed by `notify-listener.ts` via the
//      `broadcastTick` handle — this module never opens its own LISTEN
//      connection.
//
// The v3 snapshot/batch model lived in this file until commit f04c124-ish.
// It's gone — see git history if you need the predicate-resolver, view.upsert
// flow, or chat.added/removed delta logic.
//
// Wire format: NDJSON (one JSON message per WS frame). String frames only.

import { type ClientFrame, type ServerFrame, WS_PROTOCOL_VERSION } from "../../../packages/sync-v3/contracts";
import type { Repo } from "./repo";
import { type Telemetry, makeNoopTelemetry, makePostgresTelemetry } from "./telemetry";

export type V3SocketData = {
  kind: "v3";
  clientId: string | null;
  closed: boolean;
  /** v3_client_sessions row id; null until telemetry hello fires. */
  sessionId: number | null;
  /** opening request metadata for telemetry on hello */
  openMeta: { userAgent: string | null; ip: string | null };
};

export type V3WebSocket = {
  data: V3SocketData;
  send(msg: string): number;
  close(code?: number, reason?: string): void;
};

export function newV3SocketData(openMeta?: { userAgent: string | null; ip: string | null }): V3SocketData {
  return {
    kind: "v3",
    clientId: null,
    closed: false,
    sessionId: null,
    openMeta: openMeta ?? { userAgent: null, ip: null },
  };
}

// ---------- public API ----------------------------------------------------

export type WsHandlers = {
  onOpen(ws: V3WebSocket): void;
  onMessage(ws: V3WebSocket, raw: string | Buffer | Uint8Array): Promise<void>;
  onClose(ws: V3WebSocket): void;
  /** Push a `tick` to every open socket. Called by notify-listener.ts when
   *  the debounce window closes. Bytes go out best-effort — failed writes
   *  drop the socket on next read. */
  broadcastTick(maxRev: number, files?: number[]): void;
};

export type WsContext = {
  repo: Repo;
  telemetry?: Telemetry;
  log?: (level: "debug" | "info" | "warn" | "error", event: string, ctx?: unknown) => void;
};

export function makeHandlers(ctx: WsContext): WsHandlers {
  const sockets = new Set<V3WebSocket>();
  const telemetry: Telemetry = ctx.telemetry ?? makeNoopTelemetry();

  const log = ctx.log ?? ((level, event, _ctx) => {
    if (level === "error" || level === "warn") console.warn(`[sync-v4 ws] ${event}`, _ctx ?? "");
  });

  function send(ws: V3WebSocket, frame: ServerFrame): number | null {
    try {
      const json = JSON.stringify(frame);
      ws.send(json);
      return json.length;
    } catch (err) {
      log("warn", "send.failed", err);
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        event: "frame.send.failed",
        level: "error",
        payload: { op: frame.op, err: errMsg(err) },
      });
      return null;
    }
  }

  return {
    onOpen(ws) {
      sockets.add(ws);
    },

    onClose(ws) {
      ws.data.closed = true;
      sockets.delete(ws);
      if (ws.data.sessionId !== null) {
        telemetry.recordSessionClose(ws.data.sessionId, 0, null).catch(() => {});
      }
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        event: "ws.disconnect",
        level: "info",
      });
    },

    broadcastTick(maxRev, files) {
      const frame: ServerFrame = files && files.length > 0 ? { op: "tick", maxRev, files } : { op: "tick", maxRev };
      for (const ws of sockets) {
        if (ws.data.closed) continue;
        send(ws, frame);
      }
    },

    async onMessage(ws, raw) {
      let frame: ClientFrame;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        frame = JSON.parse(text) as ClientFrame;
      } catch (err) {
        log("warn", "parse.failed", err);
        return;
      }

      switch (frame.op) {
        case "hello": {
          ws.data.clientId = frame.clientId;
          let maxRev = 0;
          try {
            maxRev = await ctx.repo.fetchMaxRev();
          } catch (err) {
            log("warn", "hello.fetchMaxRev.failed", err);
          }
          send(ws, { op: "hello.ok", v: WS_PROTOCOL_VERSION, serverTime: new Date().toISOString(), maxRev });

          try {
            const sid = await telemetry.recordSessionOpen({
              clientId: frame.clientId,
              userAgent: ws.data.openMeta.userAgent,
              ip: ws.data.openMeta.ip,
              deviceMemoryGb: frame.deviceMemoryGb ?? null,
              protocolVersion: frame.v,
              viewsAtOpen: [],
            });
            if (sid !== null) ws.data.sessionId = sid;
          } catch {}
          telemetry.log({
            clientId: frame.clientId,
            event: "ws.connect",
            level: "info",
            payload: {
              v: frame.v,
              deviceMemoryGb: frame.deviceMemoryGb ?? null,
              ua: ws.data.openMeta.userAgent,
            },
          });
          return;
        }

        case "query":
        case "query.run": {
          // `query` and `query.run` carry identical semantics; the only
          // difference is the reply op name (`query.ok` vs `query.run.ok`)
          // so existing DevTools snippets that branch on op keep working.
          const t0 = Date.now();
          const useV4Reply = frame.op === "query";
          try {
            const result = await ctx.repo.runRawQueryWithMaxRev({
              sql: frame.sql,
              params: frame.params,
            });
            const okFrame: ServerFrame = useV4Reply
              ? {
                  op: "query.ok",
                  reqId: frame.reqId,
                  rows: result.rows,
                  rowCount: result.rows.length,
                  durationMs: result.durationMs,
                  truncated: result.truncated,
                  maxRev: result.maxRev,
                }
              : {
                  op: "query.run.ok",
                  reqId: frame.reqId,
                  rows: result.rows,
                  rowCount: result.rows.length,
                  durationMs: result.durationMs,
                  truncated: result.truncated,
                  maxRev: result.maxRev,
                };
            const bytes = send(ws, okFrame);
            telemetry.log({
              clientId: ws.data.clientId ?? null,
              event: frame.op,
              level: "info",
              durationMs: Date.now() - t0,
              bytes,
              payload: {
                rowCount: result.rows.length,
                truncated: result.truncated,
                sqlLen: frame.sql.length,
              },
            });
          } catch (err) {
            const errFrame: ServerFrame = useV4Reply
              ? { op: "query.err", reqId: frame.reqId, error: errMsg(err) }
              : { op: "query.run.err", reqId: frame.reqId, error: errMsg(err) };
            send(ws, errFrame);
            telemetry.log({
              clientId: ws.data.clientId ?? null,
              event: `${frame.op}.failed`,
              level: "warn",
              durationMs: Date.now() - t0,
              payload: { error: errMsg(err), sqlLen: frame.sql.length },
            });
          }
          return;
        }

        case "ping": {
          send(ws, { op: "pong" });
          return;
        }
      }
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- persistence context (telemetry only in v4) --------------------

export function makePostgresContext(sql: any, repo: Repo): WsContext {
  return {
    repo,
    telemetry: makePostgresTelemetry(sql),
  };
}
