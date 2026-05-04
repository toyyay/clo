// Top bar — visually echoes the legacy client (☰ burger, chat title +
// metadata, sync pill, Aa, ⋯ menu).

import { useEffect, useState } from "react";
import { useStore, useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";
import { SettingsPopover, useVisualSettings } from "./settings";
import { SyncStatusPopover } from "./sync-status-popover";

export function Topbar({ onToggleSidebar, sidebarOpen }: { onToggleSidebar: () => void; sidebarOpen: boolean }) {
  const state = useStoreState();
  const activeChat = state.activeChat ? state.visibleChats.get(state.activeChat) : null;
  const visual = useVisualSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="topbar">
      <button
        className="icon-btn topbar-burger"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide chats" : "Show chats"}
        title={sidebarOpen ? "Hide chats" : "Show chats"}
      >
        ☰
      </button>

      <div className="topbar-center">
        {activeChat ? (
          <>
            <div className="topbar-title">{activeChat.title || activeChat.chatId}</div>
            <div className="topbar-meta">
              {formatRelative(activeChat.lastSeenAt)}
              <span className="dot">·</span>
              {activeChat.itemCount.toLocaleString()} items
              <span className="dot">·</span>
              {formatBytes(activeChat.approxBytes)}
              <span className="dot">·</span>
              {activeChat.provider}
            </div>
          </>
        ) : (
          <div className="topbar-title topbar-title-empty">Chats</div>
        )}
      </div>

      <SyncProgress />
      <SyncPill />

      <button
        className="icon-btn settings-button"
        onClick={() => setSettingsOpen((v) => !v)}
        aria-label="Display settings"
        title="Display settings"
      >
        Aa
      </button>
      {settingsOpen && (
        <SettingsPopover
          theme={visual.theme}
          fontScale={visual.fontScale}
          onThemeChange={visual.setTheme}
          onFontScaleChange={visual.setFontScale}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <AppMenu />
      <BacklogBar />
    </header>
  );
}

/** Thin indeterminate progress bar painted at the bottom edge of the topbar
 *  while there's pending sync backlog or we're in the middle of (re)connecting.
 *  Tells the user "the app isn't frozen, data is still flowing" without
 *  needing them to open the diagnostics popover. */
function BacklogBar() {
  const state = useStoreState();
  let pending = 0;
  for (const v of state.pendingBytes.values()) pending += v;
  const kind = state.status.kind;
  const visible =
    kind === "connecting" ||
    kind === "reconnecting" ||
    (kind === "open" && pending > 16_384);
  if (!visible) return null;
  return <div className="backlog-bar" aria-hidden="true" />;
}

function SyncProgress() {
  const state = useStoreState();
  let bytes = 0;
  for (const v of state.pendingBytes.values()) bytes += v;
  if (bytes === 0) return null;
  return (
    <div className="sync-progress" title={`${formatBytes(bytes)} pending`}>
      ⤓ {formatBytes(bytes)}
    </div>
  );
}

function SyncPill() {
  const state = useStoreState();
  const [open, setOpen] = useState(false);
  const kind = state.status.kind;
  let totalPending = 0;
  for (const v of state.pendingBytes.values()) totalPending += v;
  const stuck = kind === "open" && totalPending > 0 && state.link.lastFrameAt !== null && (Date.now() - state.link.lastFrameAt) > 20_000;
  const label = stuck ? "?!" : kind === "open" ? "ok" : kind === "connecting" ? "…" : kind === "reconnecting" ? "rec" : kind === "closed" ? "off" : "—";
  const pillKind = stuck ? "stuck" : kind;
  return (
    <>
      <button
        className={`sync-pill sync-pill-${pillKind}`}
        title="Click for sync diagnostics"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sync-dot" />
        <span className="sync-label">{label}</span>
      </button>
      {open && <SyncStatusPopover onClose={() => setOpen(false)} />}
    </>
  );
}

function AppMenu() {
  const store = useStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".app-menu-pop") || t.closest(".app-menu-button")) return;
      setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const reload = () => location.reload();
  const resetAndReload = async () => {
    if (!confirm("Reset local cache and reload? This drops IndexedDB, view subscriptions and the local client id.")) return;
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
  const forceResync = () => {
    store.stop();
    setTimeout(() => location.reload(), 100);
  };

  return (
    <>
      <button
        className="icon-btn app-menu-button"
        aria-label="App menu"
        onClick={() => setOpen((v) => !v)}
        title="App menu"
      >
        ⋯
      </button>
      {open && (
        <div className="app-menu-pop">
          <button onClick={reload}>Reload</button>
          <button onClick={forceResync}>Force re-sync</button>
          <button onClick={resetAndReload}>Reset & reload</button>
          <a href="/v2">Open legacy /v2</a>
        </div>
      )}
    </>
  );
}
