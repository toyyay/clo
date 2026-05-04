// WebSocket server for sync-v3.
//
// One connection per browser tab. All views multiplex through a single socket.
// Pub-sub model with explicit acks: server doesn't advance cursor until client
// confirms the batch landed.
//
// Wire format: NDJSON (one JSON message per WS frame). Bun's `ServerWebSocket`
// supports both string and binary frames; we use strings.
//
// Lifecycle:
//   client → "hello" with view list + last cursors
//   server → "hello.ok" + per-view "view.snapshot" or delta as needed
//   client ↔ server live frames; client acks every batch
//   on disconnect: cursor in DB stays at last acked value, replay on reconnect

import { canonicalizeSpec, type ClientFrame, type ServerFrame, type ViewSpec, WS_PROTOCOL_VERSION } from "../../../packages/sync-v3/contracts";
import type { Repo } from "./repo";
import { createHash } from "node:crypto";

export type V3SocketData = {
  kind: "v3";
  clientId: string | null;
  /** active view specs by viewId (server-side cache) */
  views: Map<string, ViewSpec>;
  /** highest acked cursor per view */
  acked: Map<string, number>;
  /** highest cursor *sent* per view (>= acked) */
  pending: Map<string, number>;
  /** pull-loop scheduled tick handles per view */
  ticking: Set<string>;
  /** when set, we still need to drain this view */
  dirty: Set<string>;
  /** abort signal for in-flight queries when socket closes */
  closed: boolean;
};

export type V3WebSocket = {
  data: V3SocketData;
  send(msg: string): number;
  close(code?: number, reason?: string): void;
};

export function newV3SocketData(): V3SocketData {
  return {
    kind: "v3",
    clientId: null,
    views: new Map(),
    acked: new Map(),
    pending: new Map(),
    ticking: new Set(),
    dirty: new Set(),
    closed: false,
  };
}

export function specHash(spec: ViewSpec): string {
  return createHash("sha256").update(canonicalizeSpec(spec)).digest("hex").slice(0, 32);
}

// ---------- public API ----------------------------------------------------

export type WsHandlers = {
  onOpen(ws: V3WebSocket): void;
  onMessage(ws: V3WebSocket, raw: string | Buffer | Uint8Array): Promise<void>;
  onClose(ws: V3WebSocket): void;
  /** Called by ingest hook (or a polling tick) when new events arrive that may */
  /** match views on connected sockets.                                          */
  notifyNewEvents(maxRevision: number): void;
};

export type WsContext = {
  repo: Repo;
  /** Persistence callbacks for client_views / client_view_cursors. */
  persistView?(clientId: string, view: ViewSpec, hash: string): Promise<void>;
  loadViews?(clientId: string): Promise<{ view: ViewSpec; cursor: number; hash: string }[]>;
  saveCursor?(clientId: string, viewId: string, cursor: number): Promise<void>;
  deleteView?(clientId: string, viewId: string): Promise<void>;
  /** logger — optional, defaults to console.warn for errors */
  log?: (level: "debug" | "info" | "warn" | "error", event: string, ctx?: unknown) => void;
};

export function makeHandlers(ctx: WsContext): WsHandlers {
  const sockets = new Set<V3WebSocket>();

  const log = ctx.log ?? ((level, event, _ctx) => {
    if (level === "error" || level === "warn") console.warn(`[sync-v3 ws] ${event}`, _ctx ?? "");
  });

  function send(ws: V3WebSocket, frame: ServerFrame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log("warn", "send.failed", err);
    }
  }

  async function pushSnapshot(ws: V3WebSocket, view: ViewSpec) {
    try {
      const snap = await ctx.repo.buildSnapshot(view);
      ws.data.pending.set(view.id, snap.cursor);
      send(ws, {
        op: "view.snapshot",
        viewId: view.id,
        cursor: snap.cursor,
        groups: snap.groups,
        chats: snap.chats,
        tails: snap.tails,
        totals: snap.totals,
      });
    } catch (err) {
      log("error", "snapshot.failed", err);
      send(ws, { op: "view.error", viewId: view.id, reason: errMsg(err) });
    }
  }

  async function drainView(ws: V3WebSocket, viewId: string) {
    if (ws.data.closed) return;
    const view = ws.data.views.get(viewId);
    if (!view) return;
    const since = ws.data.pending.get(viewId) ?? ws.data.acked.get(viewId) ?? 0;

    try {
      const delta = await ctx.repo.fetchDelta(view, since);
      if (delta.items.length === 0) {
        if (delta.bytesRemaining === 0) {
          send(ws, { op: "view.idle", viewId, cursor: since });
        }
        ws.data.dirty.delete(viewId);
        return;
      }
      ws.data.pending.set(viewId, delta.cursor);
      send(ws, {
        op: "view.batch",
        viewId,
        cursor: delta.cursor,
        items: delta.items,
        bytesRemaining: delta.bytesRemaining,
        moreReady: delta.moreReady,
      });
    } catch (err) {
      log("error", "drain.failed", err);
      send(ws, { op: "view.error", viewId, reason: errMsg(err) });
    }
  }

  /**
   * Schedules a drain for a view, with debounce so multiple notifyNewEvents
   * calls coalesce. Single-flight per (socket, viewId): subsequent ticks while
   * a drain is already in flight just mark dirty.
   */
  function scheduleDrain(ws: V3WebSocket, viewId: string) {
    if (ws.data.closed) return;
    ws.data.dirty.add(viewId);
    if (ws.data.ticking.has(viewId)) return;
    ws.data.ticking.add(viewId);
    queueMicrotask(async () => {
      while (ws.data.dirty.has(viewId) && !ws.data.closed) {
        ws.data.dirty.delete(viewId);
        await drainView(ws, viewId);
      }
      ws.data.ticking.delete(viewId);
    });
  }

  return {
    onOpen(ws) {
      sockets.add(ws);
    },

    async onMessage(ws, raw) {
      let frame: ClientFrame;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        frame = JSON.parse(text);
      } catch {
        send(ws, { op: "view.error", viewId: "*", reason: "invalid_json" });
        return;
      }
      try {
        await handleFrame(ws, frame);
      } catch (err) {
        log("error", "handle.failed", err);
        send(ws, { op: "view.error", viewId: (frame as any).viewId ?? "*", reason: errMsg(err) });
      }
    },

    onClose(ws) {
      ws.data.closed = true;
      sockets.delete(ws);
    },

    notifyNewEvents(_maxRevision: number) {
      for (const ws of sockets) {
        if (ws.data.closed) continue;
        for (const viewId of ws.data.views.keys()) {
          scheduleDrain(ws, viewId);
        }
      }
    },
  };

  // ---------- frame handlers (closure over send / drainView) ---------------

  async function handleFrame(ws: V3WebSocket, frame: ClientFrame) {
    switch (frame.op) {
      case "hello": {
        ws.data.clientId = frame.clientId;
        send(ws, { op: "hello.ok", v: WS_PROTOCOL_VERSION, serverTime: new Date().toISOString() });

        // Preload views from DB if persistence wired in
        if (ctx.loadViews && ws.data.clientId) {
          try {
            const stored = await ctx.loadViews(ws.data.clientId);
            for (const { view, cursor } of stored) {
              ws.data.views.set(view.id, view);
              ws.data.acked.set(view.id, cursor);
              ws.data.pending.set(view.id, cursor);
            }
          } catch (err) {
            log("warn", "loadViews.failed", err);
          }
        }

        // Compare specHash for each view client claims.
        for (const declared of frame.views) {
          const view = ws.data.views.get(declared.viewId);
          if (!view) continue; // client thinks it has a view server doesn't know
          const serverHash = specHash(view);
          if (serverHash !== declared.specHash) {
            // Spec changed — full snapshot, ignore claimed cursor.
            await pushSnapshot(ws, view);
            continue;
          }
          // Spec same — adopt client's cursor (it might be ahead of server's
          // last known if server just restarted).
          const cursor = Math.max(declared.cursor, ws.data.acked.get(view.id) ?? 0);
          ws.data.acked.set(view.id, cursor);
          ws.data.pending.set(view.id, cursor);
          scheduleDrain(ws, view.id);
        }

        // Snapshot any server-side views that the client didn't declare.
        for (const view of ws.data.views.values()) {
          const claimed = frame.views.find((v) => v.viewId === view.id);
          if (!claimed) await pushSnapshot(ws, view);
        }
        return;
      }

      case "view.upsert": {
        const view = frame.view;
        ws.data.views.set(view.id, view);
        ws.data.acked.set(view.id, ws.data.acked.get(view.id) ?? 0);
        ws.data.pending.set(view.id, ws.data.pending.get(view.id) ?? 0);
        if (ctx.persistView && ws.data.clientId) {
          try {
            await ctx.persistView(ws.data.clientId, view, specHash(view));
          } catch (err) {
            log("warn", "persistView.failed", err);
          }
        }
        await pushSnapshot(ws, view);
        return;
      }

      case "view.delete": {
        ws.data.views.delete(frame.viewId);
        ws.data.acked.delete(frame.viewId);
        ws.data.pending.delete(frame.viewId);
        if (ctx.deleteView && ws.data.clientId) {
          await ctx.deleteView(ws.data.clientId, frame.viewId).catch(() => {});
        }
        return;
      }

      case "view.ack": {
        ws.data.acked.set(frame.viewId, frame.cursor);
        if (ctx.saveCursor && ws.data.clientId) {
          ctx.saveCursor(ws.data.clientId, frame.viewId, frame.cursor).catch(() => {});
        }
        // After ack, see if there's more to drain
        scheduleDrain(ws, frame.viewId);
        return;
      }

      case "view.focus": {
        // priority boost — for now just trigger an immediate drain
        scheduleDrain(ws, frame.viewId);
        return;
      }

      case "chat.exclude": {
        const view = ws.data.views.get(frame.viewId);
        if (!view) return;
        const next: ViewSpec = { ...view, excludes: [...(view.excludes ?? []), frame.chatId] };
        ws.data.views.set(view.id, next);
        if (ctx.persistView && ws.data.clientId) {
          ctx.persistView(ws.data.clientId, next, specHash(next)).catch(() => {});
        }
        send(ws, { op: "chat.removed", viewId: view.id, chatId: frame.chatId, reason: "excluded", evictHint: true });
        return;
      }

      case "chat.include": {
        const view = ws.data.views.get(frame.viewId);
        if (!view) return;
        const next: ViewSpec = {
          ...view,
          includes: Array.from(new Set([...(view.includes ?? []), frame.chatId])),
          excludes: (view.excludes ?? []).filter((id) => id !== frame.chatId),
        };
        ws.data.views.set(view.id, next);
        if (ctx.persistView && ws.data.clientId) {
          ctx.persistView(ws.data.clientId, next, specHash(next)).catch(() => {});
        }
        await pushSnapshot(ws, next);
        return;
      }

      case "history.range": {
        const result = await ctx.repo.fetchHistoryRange({
          chatId: frame.chatId,
          before: frame.before,
          after: frame.after,
          limit: frame.limit,
        });
        send(ws, {
          op: "history.range.ok",
          reqId: frame.reqId,
          chatId: frame.chatId,
          items: result.items,
          hasOlder: result.hasOlder,
          hasNewer: result.hasNewer,
        });
        return;
      }

      case "ping": {
        send(ws, { op: "pong" });
        return;
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- persistence helpers (Postgres) --------------------------------

export function makePostgresContext(sql: any, repo: Repo): WsContext {
  return {
    repo,
    async persistView(clientId, view, hash) {
      await sql`
        insert into client_views (client_id, view_id, spec, spec_hash, updated_at)
        values (${clientId}, ${view.id}, ${view}::jsonb, ${hash}, now())
        on conflict (client_id, view_id) do update set
          spec = excluded.spec,
          spec_hash = excluded.spec_hash,
          updated_at = now()
      `;
    },
    async loadViews(clientId) {
      const rows = await sql`
        select v.spec, v.spec_hash, coalesce(c.cursor, 0) as cursor
        from client_views v
        left join client_view_cursors c
          on c.client_id = v.client_id and c.view_id = v.view_id
        where v.client_id = ${clientId}
      `;
      return rows.map((r: any) => ({
        view: r.spec as ViewSpec,
        hash: r.spec_hash,
        cursor: Number(r.cursor ?? 0),
      }));
    },
    async saveCursor(clientId, viewId, cursor) {
      await sql`
        insert into client_view_cursors (client_id, view_id, cursor, updated_at)
        values (${clientId}, ${viewId}, ${cursor}, now())
        on conflict (client_id, view_id) do update set
          cursor = greatest(client_view_cursors.cursor, excluded.cursor),
          updated_at = now()
      `;
    },
    async deleteView(clientId, viewId) {
      await sql`delete from client_views where client_id = ${clientId} and view_id = ${viewId}`;
      await sql`delete from client_view_cursors where client_id = ${clientId} and view_id = ${viewId}`;
    },
  };
}
