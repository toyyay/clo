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
import { type Telemetry, makeNoopTelemetry, makePostgresTelemetry } from "./telemetry";

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
  /** views whose initial snapshot is still in flight; drainView skips them */
  /** until the snapshot lands so client doesn't get batches before snapshot. */
  snapshotting: Set<string>;
  /** abort signal for in-flight queries when socket closes */
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
    views: new Map(),
    acked: new Map(),
    pending: new Map(),
    ticking: new Set(),
    dirty: new Set(),
    snapshotting: new Set(),
    closed: false,
    sessionId: null,
    openMeta: openMeta ?? { userAgent: null, ip: null },
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
  /** match views on connected sockets. Triggers a drain for every view.        */
  notifyNewEvents(maxRevision: number): void;
  /** Called when a specific chat received new events. If any followNew view    */
  /** matches and the chat isn't yet a member, emits chat.added.                */
  notifyAffectedChat(sourceFileId: number): void;
  /** v4: broadcast a `tick` frame to every open socket. `files` is omitted by  */
  /** the caller when the affected-files set is too large to fit in one frame. */
  broadcastTick(maxRev: number, files?: number[]): void;
};

export type WsContext = {
  repo: Repo;
  /** Persistence callbacks for client_views / client_view_cursors. */
  persistView?(clientId: string, view: ViewSpec, hash: string): Promise<void>;
  loadViews?(clientId: string): Promise<{ view: ViewSpec; cursor: number; hash: string }[]>;
  saveCursor?(clientId: string, viewId: string, cursor: number): Promise<void>;
  deleteView?(clientId: string, viewId: string): Promise<void>;
  /** Mark chat as member of a view (for followNew to know what's new). */
  recordViewChat?(clientId: string, viewId: string, sourceFileId: number, seq: number): Promise<void>;
  /** Remove chat membership when excluded. */
  removeViewChat?(clientId: string, viewId: string, sourceFileId: number): Promise<void>;
  /** Telemetry: WS-session lifecycle and structured event log. */
  telemetry?: Telemetry;
  /** logger — optional, defaults to console.warn for errors */
  log?: (level: "debug" | "info" | "warn" | "error", event: string, ctx?: unknown) => void;
};

export function makeHandlers(ctx: WsContext): WsHandlers {
  const sockets = new Set<V3WebSocket>();
  const telemetry: Telemetry = ctx.telemetry ?? makeNoopTelemetry();

  const log = ctx.log ?? ((level, event, _ctx) => {
    if (level === "error" || level === "warn") console.warn(`[sync-v3 ws] ${event}`, _ctx ?? "");
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
        viewId: (frame as any).viewId ?? null,
        event: "frame.send.failed",
        level: "error",
        payload: { op: frame.op, err: errMsg(err) },
      });
      return null;
    }
  }

  async function pushSnapshot(ws: V3WebSocket, view: ViewSpec) {
    // Idempotency: if a snapshot is already in flight for this view, skip.
    if (ws.data.snapshotting.has(view.id)) {
      log("debug", "snapshot.skipped.in_flight", { viewId: view.id });
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        viewId: view.id,
        event: "snapshot.skipped",
        level: "debug",
        payload: { reason: "in_flight" },
      });
      return;
    }
    ws.data.snapshotting.add(view.id);
    const t0 = Date.now();
    try {
      const snap = await ctx.repo.buildSnapshot(view);
      ws.data.pending.set(view.id, snap.cursor);
      ws.data.acked.set(view.id, Math.max(ws.data.acked.get(view.id) ?? 0, snap.cursor));
      const bytes = send(ws, {
        op: "view.snapshot",
        viewId: view.id,
        cursor: snap.cursor,
        groups: snap.groups,
        chats: snap.chats,
        tails: snap.tails,
        totals: snap.totals,
      });
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        viewId: view.id,
        event: "snapshot.sent",
        level: "info",
        durationMs: Date.now() - t0,
        bytes,
        payload: {
          cursor: snap.cursor,
          groups: snap.groups.length,
          chats: snap.chats.length,
          tailKeys: Object.keys(snap.tails).length,
        },
      });

      if (ctx.recordViewChat && ws.data.clientId) {
        for (const chat of snap.chats) {
          const sourceFileId = parseSourceFileId(chat.chatId);
          if (sourceFileId === null) continue;
          const lastSeq = (snap.tails[chat.chatId] ?? []).at(-1)?.seq ?? 0;
          ctx.recordViewChat(ws.data.clientId, view.id, sourceFileId, lastSeq).catch(() => {});
        }
      }
    } catch (err) {
      log("error", "snapshot.failed", err);
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        viewId: view.id,
        event: "snapshot.failed",
        level: "error",
        durationMs: Date.now() - t0,
        payload: { error: errMsg(err) },
      });
      send(ws, { op: "view.error", viewId: view.id, reason: errMsg(err) });
    } finally {
      ws.data.snapshotting.delete(view.id);
    }
  }

  async function drainView(ws: V3WebSocket, viewId: string) {
    if (ws.data.closed) return;
    const view = ws.data.views.get(viewId);
    if (!view) return;
    if (ws.data.snapshotting.has(viewId)) return;
    const since = ws.data.pending.get(viewId) ?? ws.data.acked.get(viewId) ?? 0;
    const t0 = Date.now();

    try {
      const delta = await ctx.repo.fetchDelta(view, since);
      if (delta.items.length === 0) {
        if (delta.bytesRemaining === 0) {
          send(ws, { op: "view.idle", viewId, cursor: since });
          telemetry.log({
            clientId: ws.data.clientId ?? null,
            viewId,
            event: "view.idle",
            level: "debug",
            durationMs: Date.now() - t0,
            payload: { cursor: since },
          });
        }
        ws.data.dirty.delete(viewId);
        return;
      }
      ws.data.pending.set(viewId, delta.cursor);
      const bytes = send(ws, {
        op: "view.batch",
        viewId,
        cursor: delta.cursor,
        items: delta.items,
        bytesRemaining: delta.bytesRemaining,
        moreReady: delta.moreReady,
      });
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        viewId,
        event: "batch.sent",
        level: "info",
        durationMs: Date.now() - t0,
        bytes,
        payload: { items: delta.items.length, cursor: delta.cursor, bytesRemaining: delta.bytesRemaining },
      });
    } catch (err) {
      log("error", "drain.failed", err);
      telemetry.log({
        clientId: ws.data.clientId ?? null,
        viewId,
        event: "drain.failed",
        level: "error",
        durationMs: Date.now() - t0,
        payload: { error: errMsg(err) },
      });
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
      } catch (err) {
        send(ws, { op: "view.error", viewId: "*", reason: "invalid_json" });
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          event: "frame.parse.failed",
          level: "warn",
          payload: { error: errMsg(err) },
        });
        return;
      }
      // Touch session liveness on every received frame, not just on ack.
      // Otherwise a quiet view (cursor up-to-date, only view.idle from server,
      // no client acks) keeps `last_seen_at` stale.
      if (ws.data.sessionId !== null) {
        telemetry.recordSessionPing(ws.data.sessionId).catch(() => {});
      }
      try {
        await handleFrame(ws, frame);
      } catch (err) {
        log("error", "handle.failed", err);
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          viewId: (frame as any).viewId ?? null,
          event: "frame.handle.failed",
          level: "error",
          payload: { op: (frame as any).op, error: errMsg(err) },
        });
        send(ws, { op: "view.error", viewId: (frame as any).viewId ?? "*", reason: errMsg(err) });
      }
    },

    onClose(ws) {
      ws.data.closed = true;
      sockets.delete(ws);
      const sid = ws.data.sessionId;
      const cid = ws.data.clientId;
      if (sid !== null) {
        // disconnected_at + close_code unknown — Bun doesn't surface them in the
        // close handler signature we get; log a synthetic close.
        telemetry.recordSessionClose(sid, 0, null).catch(() => {});
      }
      telemetry.log({
        clientId: cid ?? null,
        event: "ws.close",
        level: "info",
        payload: { views: Array.from(ws.data.views.keys()) },
      });
    },

    notifyNewEvents(_maxRevision: number) {
      // Опционально: вызывающий может передавать affectedSourceFileIds через
      // notifyAffectedChat — это даёт следящим подпискам шанс прислать chat.added.
      for (const ws of sockets) {
        if (ws.data.closed) continue;
        for (const viewId of ws.data.views.keys()) {
          scheduleDrain(ws, viewId);
        }
      }
    },
    broadcastTick(maxRev: number, files?: number[]) {
      // v4 transport: dumb fan-out. Clients drive their own re-pull strategy.
      const frame: ServerFrame = files !== undefined
        ? { op: "tick", maxRev, files }
        : { op: "tick", maxRev };
      for (const ws of sockets) {
        if (ws.data.closed) continue;
        send(ws, frame);
      }
    },
    notifyAffectedChat(sourceFileId: number) {
      // Это вызывается ingest-хуком когда есть конкретный source_file_id с новыми
      // events. Для каждого открытого сокета: если есть view с followNew=true,
      // которому этот чат подходит и пока не входит в подписку — шлём chat.added.
      void (async () => {
        try {
          const matches = await ctx.repo.resolveMatchingViews(sourceFileId);
          for (const ws of sockets) {
            if (ws.data.closed || !ws.data.clientId) continue;
            for (const view of ws.data.views.values()) {
              if (!view.followNew) {
                scheduleDrain(ws, view.id);
                continue;
              }
              const match = matches.find(
                (m) => m.clientId === ws.data.clientId && m.viewId === view.id,
              );
              if (!match) {
                scheduleDrain(ws, view.id);
                continue;
              }
              if (match.alreadyMember) {
                scheduleDrain(ws, view.id);
                continue;
              }
              // New chat enters the view → send chat.added
              try {
                const [chat, tail] = await Promise.all([
                  ctx.repo.fetchChatIndex(sourceFileId),
                  ctx.repo.fetchChatTailById(sourceFileId, view.history?.tailItems ?? 200),
                ]);
                if (!chat) continue;
                const lastSeq = tail.length ? tail[tail.length - 1]!.seq : 0;
                if (ctx.recordViewChat) {
                  await ctx.recordViewChat(ws.data.clientId, view.id, sourceFileId, lastSeq).catch(() => {});
                }
                send(ws, { op: "chat.added", viewId: view.id, chat, tail });
              } catch (err) {
                log("warn", "chat.added.failed", err);
              }
            }
          }
        } catch (err) {
          log("warn", "notifyAffectedChat.failed", err);
        }
      })();
    },
  };

  // ---------- frame handlers (closure over send / drainView) ---------------

  async function handleFrame(ws: V3WebSocket, frame: ClientFrame) {
    switch (frame.op) {
      case "hello": {
        ws.data.clientId = frame.clientId;
        // v4: include the current max sync_revision so a reconnecting client
        // can decide whether it's caught up to the latest tick before
        // re-issuing a `query`. Best-effort — if the read fails (e.g. db
        // hiccup) we still send hello.ok so the legacy v3 path stays alive.
        let maxRev = 0;
        try {
          maxRev = await ctx.repo.fetchMaxRev();
        } catch (err) {
          log("warn", "hello.fetchMaxRev.failed", err);
        }
        send(ws, { op: "hello.ok", v: WS_PROTOCOL_VERSION, serverTime: new Date().toISOString(), maxRev });

        // Telemetry: open session row, log structured event.
        try {
          const sid = await telemetry.recordSessionOpen({
            clientId: frame.clientId,
            userAgent: ws.data.openMeta.userAgent,
            ip: ws.data.openMeta.ip,
            deviceMemoryGb: frame.deviceMemoryGb ?? null,
            protocolVersion: frame.v,
            viewsAtOpen: frame.views.map((v) => ({ viewId: v.viewId, cursor: v.cursor })),
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
            views: frame.views.map((v) => ({ viewId: v.viewId, cursor: v.cursor })),
            ua: ws.data.openMeta.userAgent,
          },
        });

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
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          viewId: view.id,
          event: "view.upsert",
          level: "info",
          payload: {
            predicate: view.predicate,
            followNew: view.followNew ?? false,
            includes: view.includes?.length ?? 0,
            excludes: view.excludes?.length ?? 0,
          },
        });
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
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          viewId: frame.viewId,
          event: "view.delete",
          level: "info",
        });
        return;
      }

      case "view.ack": {
        const previousAck = ws.data.acked.get(frame.viewId) ?? 0;
        ws.data.acked.set(frame.viewId, frame.cursor);
        if (ctx.saveCursor && ws.data.clientId) {
          ctx.saveCursor(ws.data.clientId, frame.viewId, frame.cursor).catch(() => {});
        }
        // Update session liveness on ack — cheap proxy for "still talking".
        if (ws.data.sessionId !== null) {
          telemetry.recordSessionPing(ws.data.sessionId).catch(() => {});
        }
        if (frame.cursor < previousAck) {
          telemetry.log({
            clientId: ws.data.clientId ?? null,
            viewId: frame.viewId,
            event: "ack.regressed",
            level: "warn",
            payload: { ackCursor: frame.cursor, previousAck },
          });
        }
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
        // Drop membership so followNew won't think the chat is still inside.
        const sourceFileId = parseSourceFileId(frame.chatId);
        if (ctx.removeViewChat && ws.data.clientId && sourceFileId !== null) {
          ctx.removeViewChat(ws.data.clientId, view.id, sourceFileId).catch(() => {});
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
        const t0 = Date.now();
        const result = await ctx.repo.fetchHistoryRange({
          chatId: frame.chatId,
          before: frame.before,
          after: frame.after,
          limit: frame.limit,
        });
        const bytes = send(ws, {
          op: "history.range.ok",
          reqId: frame.reqId,
          chatId: frame.chatId,
          items: result.items,
          hasOlder: result.hasOlder,
          hasNewer: result.hasNewer,
        });
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          event: "history.range",
          level: "info",
          durationMs: Date.now() - t0,
          bytes,
          payload: {
            chatId: frame.chatId,
            before: frame.before ?? null,
            after: frame.after ?? null,
            limit: frame.limit,
            items: result.items.length,
          },
        });
        return;
      }

      case "chats.byGroup": {
        const t0 = Date.now();
        const result = await ctx.repo.listChatsByGroup({
          groupKey: frame.groupKey,
          afterLastSeenAt: frame.afterLastSeenAt,
          limit: frame.limit,
        });
        const bytes = send(ws, {
          op: "chats.byGroup.ok",
          reqId: frame.reqId,
          groupKey: frame.groupKey,
          chats: result.chats,
          hasMore: result.hasMore,
        });
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          event: "chats.byGroup",
          level: "info",
          durationMs: Date.now() - t0,
          bytes,
          payload: {
            groupKey: frame.groupKey,
            limit: frame.limit,
            after: frame.afterLastSeenAt ?? null,
            chats: result.chats.length,
            hasMore: result.hasMore,
          },
        });
        return;
      }

      case "chats.search": {
        const t0 = Date.now();
        const result = await ctx.repo.searchChats({
          query: frame.query,
          limit: frame.limit,
        });
        const bytes = send(ws, {
          op: "chats.search.ok",
          reqId: frame.reqId,
          query: frame.query,
          chats: result.chats,
          hasMore: result.hasMore,
        });
        telemetry.log({
          clientId: ws.data.clientId ?? null,
          event: "chats.search",
          level: "info",
          durationMs: Date.now() - t0,
          bytes,
          payload: {
            query: frame.query.slice(0, 64),
            queryLen: frame.query.length,
            limit: frame.limit,
            hits: result.chats.length,
            hasMore: result.hasMore,
          },
        });
        return;
      }

      case "query.run":
      case "query": {
        // v3 op: "query.run" — kept for the existing client.
        // v4 op: "query"     — same semantics, different reply op name.
        // Both go through runRawQueryWithMaxRev so the v4 client can use the
        // returned `maxRev` as its tick watermark race-free with the rows.
        const t0 = Date.now();
        const isV4 = frame.op === "query";
        try {
          const result = await ctx.repo.runRawQueryWithMaxRev({
            sql: frame.sql,
            params: frame.params,
          });
          const bytes = isV4
            ? send(ws, {
                op: "query.ok",
                reqId: frame.reqId,
                rows: result.rows,
                rowCount: result.rows.length,
                durationMs: result.durationMs,
                truncated: result.truncated,
                maxRev: result.maxRev,
              })
            : send(ws, {
                op: "query.run.ok",
                reqId: frame.reqId,
                rows: result.rows,
                rowCount: result.rows.length,
                durationMs: result.durationMs,
                truncated: result.truncated,
                // Additive: v3 clients ignore unknown fields, v4-style users
                // who haven't migrated to "query" still benefit from a
                // watermark.
                maxRev: result.maxRev,
              });
          telemetry.log({
            clientId: ws.data.clientId ?? null,
            event: isV4 ? "query" : "query.run",
            level: "info",
            durationMs: Date.now() - t0,
            bytes,
            payload: {
              sqlSnippet: frame.sql.slice(0, 200),
              paramCount: Array.isArray(frame.params) ? frame.params.length : 0,
              rowCount: result.rows.length,
              truncated: result.truncated,
              dbDurationMs: result.durationMs,
              maxRev: result.maxRev,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isV4) {
            send(ws, { op: "query.err", reqId: frame.reqId, error: message });
          } else {
            send(ws, { op: "query.run.err", reqId: frame.reqId, error: message });
          }
          telemetry.log({
            clientId: ws.data.clientId ?? null,
            event: isV4 ? "query" : "query.run",
            level: "warn",
            durationMs: Date.now() - t0,
            bytes: 0,
            payload: {
              sqlSnippet: frame.sql.slice(0, 200),
              error: message,
            },
          });
        }
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

function parseSourceFileId(chatId: string): number | null {
  if (chatId.startsWith("v3:")) {
    const n = Number(chatId.slice(3));
    return Number.isFinite(n) ? n : null;
  }
  return /^\d+$/.test(chatId) ? Number(chatId) : null;
}

// ---------- persistence helpers (Postgres) --------------------------------

export function makePostgresContext(sql: any, repo: Repo): WsContext {
  return {
    repo,
    telemetry: makePostgresTelemetry(sql),
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
      await sql`delete from client_view_chats where client_id = ${clientId} and view_id = ${viewId}`;
    },
    async recordViewChat(clientId, viewId, sourceFileId, seq) {
      await sql`
        insert into client_view_chats (client_id, view_id, source_file_id, last_render_seq)
        values (${clientId}, ${viewId}, ${sourceFileId}, ${seq})
        on conflict (client_id, view_id, source_file_id) do update set
          last_render_seq = greatest(client_view_chats.last_render_seq, excluded.last_render_seq)
      `;
    },
    async removeViewChat(clientId, viewId, sourceFileId) {
      await sql`
        delete from client_view_chats
        where client_id = ${clientId} and view_id = ${viewId} and source_file_id = ${sourceFileId}
      `;
    },
  };
}
