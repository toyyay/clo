// Settings modal — about/build info, sync diagnostics summary, and
// destructive cache/storage actions (Reload, Force re-sync, Reset & reload).
//
// These items used to live in the topbar ⋯ menu but cluttered it; the menu
// now only opens this modal plus Audio. Heavy / dangerous actions belong
// in a dedicated surface where the user can read what they do.

import { useEffect, useState } from "react";
import { useStore, useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useStoreState();
  const [sha, setSha] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { commit_sha?: string }) => {
        if (cancelled) return;
        if (typeof j.commit_sha === "string") setSha(j.commit_sha);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = () => location.reload();

  const forceResync = () => {
    setMessage("Restarting sync…");
    store.stop();
    setTimeout(() => location.reload(), 100);
  };

  const resetAndReload = async () => {
    if (
      !confirm(
        "Reset local cache and reload?\nThis drops IndexedDB, view subscriptions, the local client id, and unregisters the service worker. The server keeps everything.",
      )
    )
      return;
    setBusy(true);
    setMessage("Wiping local data…");
    try {
      store.stop();
      await new Promise<void>((res) => {
        const req = indexedDB.deleteDatabase("chatview-v3");
        req.onsuccess = () => res();
        req.onerror = () => res();
        req.onblocked = () => res();
      });
      localStorage.removeItem("chatview-v3:client-id");
      localStorage.removeItem("chatview-v3:sidebar-expanded");
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n).catch(() => {})));
      }
    } catch {}
    location.reload();
  };

  let pending = 0;
  for (const v of state.pendingBytes.values()) pending += v;
  const lastFrame = state.link.lastFrameAt ? formatRelative(new Date(state.link.lastFrameAt).toISOString()) : "never";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">
            <div className="modal-section-title">About</div>
            <div className="modal-kv">
              <span>Build</span>
              <b>{sha ? sha.slice(0, 12) : "unknown"}</b>
              <span>Client id</span>
              <b>{readClientId() || "—"}</b>
              <span>WebSocket</span>
              <b>{state.status.kind}</b>
              <span>Last frame</span>
              <b>{lastFrame}</b>
              <span>Pending</span>
              <b>{formatBytes(pending)}</b>
              <span>Visible chats</span>
              <b>{state.visibleChats.size.toLocaleString()}</b>
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">Connection</div>
            <div className="modal-section-desc">
              Reload the page to recover from a stuck WebSocket. Force re-sync stops the link cleanly first.
            </div>
            <div className="modal-actions">
              <button onClick={reload}>Reload</button>
              <button onClick={forceResync} disabled={busy}>
                Force re-sync
              </button>
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">Local storage</div>
            <div className="modal-section-desc">
              Wipes IndexedDB, view subscriptions, and the local client id, then reloads. Server data is untouched.
            </div>
            <div className="modal-actions">
              <button className="danger" onClick={resetAndReload} disabled={busy}>
                Reset &amp; reload
              </button>
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">Other</div>
            <div className="modal-actions">
              <a href="/v2">Open legacy /v2</a>
              <a href="/api/agent/download?arch=arm64">Mac Agent (arm64)</a>
              <a href="/api/auth/logout">Sign out</a>
            </div>
          </div>

          {message && <div className="modal-section-desc">{message}</div>}
        </div>
      </section>
    </div>
  );
}

function readClientId(): string | null {
  try {
    return localStorage.getItem("chatview-v3:client-id");
  } catch {
    return null;
  }
}
