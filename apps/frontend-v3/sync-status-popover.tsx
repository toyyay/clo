// SyncStatusPopover — opens on click of the sync pill.
//
// Goal: at one glance answer "is sync stuck or progressing? how much left,
// how long, who am I, where's the cursor?" — the questions you actually want
// answered when something looks off.

import { useEffect, useMemo } from "react";
import { useStoreState } from "./store-hook";
import { formatBytes } from "./format";

export function SyncStatusPopover({ onClose }: { onClose: () => void }) {
  const state = useStoreState();

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".sync-status-pop") || t.closest(".sync-pill")) return;
      onClose();
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  // v4 metrics: no per-view pendingBytes / cursors / lastBatchAt — server
  // has no view state to expose. Stuck detection is purely time-since-last-
  // frame; "Server cursor" / "Pending" / "Views" rows are removed since they
  // would always be `—` / `synced` / `0` and just clutter the popover.
  const now = Date.now();
  const link = state.link;
  const sinceLastFrame = link.lastFrameAt ? now - link.lastFrameAt : null;
  const stuck = useMemo(() => {
    if (state.status.kind !== "open") return false;
    if (sinceLastFrame === null) return false;
    return sinceLastFrame > 20_000;
  }, [state.status.kind, sinceLastFrame]);

  const statusLabel = (() => {
    switch (state.status.kind) {
      case "open": return stuck ? "ONLINE — likely stuck" : "ONLINE";
      case "connecting": return "CONNECTING";
      case "reconnecting":
        return `RECONNECTING (try ${state.status.attempt}, next in ${Math.max(0, Math.ceil((state.status.nextAttemptAt - now) / 1000))}s)`;
      case "closed": return `OFFLINE — ${state.status.reason || "no link"}`;
      default: return "—";
    }
  })();

  const statusKind = stuck ? "stuck" : state.status.kind;

  return (
    <div className={`sync-status-pop sync-status-${statusKind}`}>
      <div className={`sync-status-header sync-status-header-${statusKind}`}>{statusLabel}</div>

      <div className="sync-status-grid">
        <Row label="Ping RTT" value={link.pingRttMs !== null ? `${link.pingRttMs} ms` : "—"} />
        <Row label="Last frame" value={sinceLastFrame !== null ? `${ageString(sinceLastFrame)} ago` : "—"} />
        <Row label="Down" value={link.bytesIn ? formatBytes(link.bytesIn) : "—"} />
        <Row label="Up" value={link.bytesOut ? formatBytes(link.bytesOut) : "—"} />
        <Row label="Throughput" value={state.throughputBps > 0 ? `${formatBytes(Math.round(state.throughputBps))}/s` : "—"} />
        <Row label="Visible chats" value={`${state.visibleChats.size}`} />
        <Row label="Group nodes" value={`${state.groups.size}`} />
      </div>

      <div className="sync-status-foot">
        <span className="sync-status-hint">
          {stuck
            ? "No frames for >20s while link claims open. Try Force re-sync from ⋯ menu."
            : state.status.kind === "open"
              ? "Click outside to close"
              : "Will retry automatically"}
        </span>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <>
      <div className="sync-status-key">{label}</div>
      <div className={`sync-status-val ${highlight ? "sync-status-val-hl" : ""}`}>{value}</div>
    </>
  );
}

function ageString(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

