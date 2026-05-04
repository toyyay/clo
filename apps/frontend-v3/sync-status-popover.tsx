// SyncStatusPopover — opens on click of the sync pill.
//
// Goal: at one glance answer "is sync stuck or progressing? how much left,
// how long, who am I, where's the cursor?" — the questions you actually want
// answered when something looks off.

import { useEffect, useMemo } from "react";
import { useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";

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

  // Aggregate metrics
  let totalPending = 0;
  for (const v of state.pendingBytes.values()) totalPending += v;
  let lastBatchAt = 0;
  for (const t of state.lastBatchAt.values()) lastBatchAt = Math.max(lastBatchAt, t);

  const now = Date.now();
  const link = state.link;
  const sinceLastFrame = link.lastFrameAt ? now - link.lastFrameAt : null;
  const stuck = useMemo(() => {
    // "stuck" heuristic: status open + we have pending bytes + no frame in 20s
    if (state.status.kind !== "open") return false;
    if (totalPending === 0) return false;
    if (sinceLastFrame === null) return false;
    return sinceLastFrame > 20_000;
  }, [state.status.kind, totalPending, sinceLastFrame]);
  const etaSec = totalPending > 0 && state.throughputBps > 0
    ? Math.ceil(totalPending / state.throughputBps)
    : null;
  const maxCursor = useMemo(() => {
    let max = 0;
    for (const c of state.cursors.values()) if (c > max) max = c;
    return max;
  }, [state.cursors]);

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
        <Row label="Server cursor" value={maxCursor > 0 ? `#${maxCursor.toLocaleString()}` : "—"} />
        <Row label="Pending" value={totalPending > 0 ? `${formatBytes(totalPending)} (~${etaSec ? formatEta(etaSec) : "?"})` : "synced ✓"} highlight={totalPending > 0} />
        <Row label="Views" value={`${state.views.size}`} />
        <Row label="Chats in view" value={`${state.visibleChats.size}`} />
        <Row label="Group nodes" value={`${state.groups.size}`} />
      </div>

      {state.views.size > 0 && (
        <>
          <div className="sync-status-section-label">Per view</div>
          <div className="sync-status-views">
            {[...state.views.values()].map((view) => {
              const cursor = state.cursors.get(view.id) ?? 0;
              const pend = state.pendingBytes.get(view.id) ?? 0;
              const lastBatch = state.lastBatchAt.get(view.id) ?? 0;
              const sinceBatch = lastBatch > 0 ? now - lastBatch : null;
              return (
                <div key={view.id} className="sync-status-view-row">
                  <div className="sync-status-view-name">{view.id}</div>
                  <div className="sync-status-view-meta">
                    cursor #{cursor.toLocaleString()}
                    <span className="dot">·</span>
                    {pend > 0 ? `${formatBytes(pend)} left` : "idle"}
                    {sinceBatch !== null && (
                      <>
                        <span className="dot">·</span>
                        last batch {ageString(sinceBatch)} ago
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="sync-status-foot">
        <span className="sync-status-hint">
          {stuck
            ? "No frames for >20s while bytes pending. Try Force re-sync from ⋯ menu."
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

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
