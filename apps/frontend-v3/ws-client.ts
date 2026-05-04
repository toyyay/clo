// Reconnecting WebSocket client for sync-v3.
//
// Контракт:
//   • открывает /api/v3/ws
//   • при reconnect шлёт hello с текущими (specHash, cursor) для всех views
//   • перед hello флушит mutation_outbox (всё что юзер делал в офлайне)
//   • для каждого фрейма от сервера зовёт on(frame)
//   • экспоненциальный backoff с jitter, max 30s
//
// Не знает про IDB напрямую — всё проходит через колбэки. Это позволяет
// тестировать клиент без браузера.

import type { ClientFrame, ServerFrame } from "../../packages/sync-v3/contracts";
import { WS_PROTOCOL_VERSION } from "../../packages/sync-v3/contracts";

export type WsClientOptions = {
  url: string;
  clientId: string;
  /** mutation outbox flush — returns frames to send before normal traffic */
  drainOutbox: () => Promise<ClientFrame[]>;
  onFrame: (frame: ServerFrame) => void;
  onStatus?: (status: ConnStatus) => void;
  /** whatwg-style logger */
  log?: (level: "debug" | "info" | "warn" | "error", event: string, ctx?: unknown) => void;
};

export type ConnStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; since: number }
  | { kind: "reconnecting"; attempt: number; nextAttemptAt: number }
  | { kind: "closed"; reason: string };

export type WsLink = {
  /** Last measured ping → pong RTT in ms, or null until first sample. */
  pingRttMs: number | null;
  /** When that sample was taken (epoch ms). */
  pingMeasuredAt: number | null;
  /** Last time we received ANY frame from the server (epoch ms). */
  lastFrameAt: number | null;
  /** Last time we sent ANY frame (epoch ms). */
  lastSentAt: number | null;
  /** Total received bytes since open. */
  bytesIn: number;
  /** Total sent bytes since open. */
  bytesOut: number;
};

export type WsClient = {
  start(): void;
  stop(): void;
  send(frame: ClientFrame): void;
  status(): ConnStatus;
  link(): WsLink;
  /** Subscribe to link metric changes (called on each frame + ping). */
  subscribeLink(listener: () => void): () => void;
};

export function createWsClient(options: WsClientOptions): WsClient {
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let queued: ClientFrame[] = [];
  let currentStatus: ConnStatus = { kind: "idle" };
  let pingSentAt: number | null = null;
  const link: WsLink = {
    pingRttMs: null,
    pingMeasuredAt: null,
    lastFrameAt: null,
    lastSentAt: null,
    bytesIn: 0,
    bytesOut: 0,
  };
  const linkListeners = new Set<() => void>();
  const notifyLink = () => {
    for (const l of linkListeners) l();
  };

  const log = options.log ?? (() => {});
  const setStatus = (s: ConnStatus) => {
    currentStatus = s;
    options.onStatus?.(s);
  };

  function scheduleReconnect() {
    if (stopped) return;
    attempt += 1;
    const delayMs = Math.min(30_000, Math.round(500 * Math.pow(2, attempt - 1) + Math.random() * 500));
    setStatus({ kind: "reconnecting", attempt, nextAttemptAt: Date.now() + delayMs });
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = setTimeout(connect, delayMs);
  }

  async function connect() {
    if (stopped) return;
    setStatus({ kind: "connecting", attempt });
    let socket: WebSocket;
    try {
      socket = new WebSocket(options.url);
    } catch (err) {
      log("warn", "ws.create.failed", err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener("open", async () => {
      attempt = 0;
      setStatus({ kind: "open", since: Date.now() });
      try {
        // Drain whatever the store queued while we were offline (queries
        // pending retry, etc.). Sent BEFORE hello so the server can attach
        // them to the same session log entry.
        const outbox = await options.drainOutbox();
        for (const frame of outbox) socket.send(JSON.stringify(frame));

        const deviceMemoryGb = typeof (navigator as any)?.deviceMemory === "number"
          ? (navigator as any).deviceMemory
          : undefined;
        socket.send(
          JSON.stringify({
            op: "hello",
            v: WS_PROTOCOL_VERSION,
            clientId: options.clientId,
            deviceMemoryGb,
          } satisfies ClientFrame),
        );

        // Drain anything queued while we were disconnected.
        for (const frame of queued.splice(0)) socket.send(JSON.stringify(frame));

        // Heartbeat — ping every 15s, capture RTT on the matching pong.
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          pingSentAt = Date.now();
          const json = JSON.stringify({ op: "ping" } satisfies ClientFrame);
          socket.send(json);
          link.lastSentAt = pingSentAt;
          link.bytesOut += json.length;
        }, 15_000);
      } catch (err) {
        log("warn", "ws.handshake.failed", err);
      }
    });

    socket.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const now = Date.now();
      link.lastFrameAt = now;
      link.bytesIn += raw.length;
      try {
        const frame = JSON.parse(raw) as ServerFrame;
        if (frame.op === "pong" && pingSentAt !== null) {
          link.pingRttMs = now - pingSentAt;
          link.pingMeasuredAt = now;
          pingSentAt = null;
        }
        notifyLink();
        options.onFrame(frame);
      } catch (err) {
        log("warn", "ws.message.parse.failed", err);
      }
    });

    socket.addEventListener("close", (ev) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      log("info", "ws.closed", { code: ev.code, reason: ev.reason });
      if (!stopped) scheduleReconnect();
      else setStatus({ kind: "closed", reason: ev.reason || "stopped" });
    });

    socket.addEventListener("error", (ev) => {
      log("warn", "ws.error", ev);
    });
  }

  return {
    start() {
      if (!stopped && currentStatus.kind === "idle") connect();
    },
    stop() {
      stopped = true;
      if (backoffTimer) clearTimeout(backoffTimer);
      if (pingTimer) clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {}
      setStatus({ kind: "closed", reason: "stopped" });
    },
    send(frame) {
      const json = JSON.stringify(frame);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        link.lastSentAt = Date.now();
        link.bytesOut += json.length;
      } else {
        queued.push(frame);
      }
    },
    status() {
      return currentStatus;
    },
    link() {
      return { ...link };
    },
    subscribeLink(listener) {
      linkListeners.add(listener);
      return () => {
        linkListeners.delete(listener);
      };
    },
  };
}

// v3's specHash helper used to live here. v4 protocol has no view-spec — the
// frontend writes its own SQL — so the helper is gone. If you need to fingerprint
// something for reconnect dedup, hash an arbitrary string the same way v3 did.

