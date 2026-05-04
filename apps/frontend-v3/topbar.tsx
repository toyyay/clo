// Top bar — ☰ burger, chat title + metadata, sync pill, Aa prefs popover, ⋯ menu.

import { useEffect, useState } from "react";
import { useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";
import { InterfacePrefsPopover, useVisualSettings } from "./settings";
import { SettingsModal } from "./settings-modal";
import { AudioModal } from "./audio-panel";
import { SyncStatusPopover } from "./sync-status-popover";

export function Topbar({ onToggleSidebar, sidebarOpen }: { onToggleSidebar: () => void; sidebarOpen: boolean }) {
  const state = useStoreState();
  const activeChat = state.activeChat ? state.visibleChats.get(state.activeChat) : null;
  const visual = useVisualSettings();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);

  return (
    <>
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

        <InterfacePrefsPopover
          open={prefsOpen}
          theme={visual.theme}
          prefs={visual.prefs}
          onToggle={() => setPrefsOpen((v) => !v)}
          onClose={() => setPrefsOpen(false)}
          onThemeChange={visual.setTheme}
          onChange={visual.updatePrefs}
          onReset={visual.resetPrefs}
        />

        <AppMenu onOpenSettings={() => setSettingsOpen(true)} onOpenAudio={() => setAudioOpen(true)} />
        <BacklogBar />
      </header>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {audioOpen && <AudioModal onClose={() => setAudioOpen(false)} />}
    </>
  );
}

/** Thin indeterminate progress bar painted at the bottom edge of the topbar
 *  while there's pending sync backlog or we're in the middle of (re)connecting. */
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

function AppMenu({ onOpenSettings, onOpenAudio }: { onOpenSettings: () => void; onOpenAudio: () => void }) {
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

  const close = () => setOpen(false);

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
          <button
            onClick={() => {
              close();
              onOpenAudio();
            }}
          >
            Audio
          </button>
          <button
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <a href="/api/agent/download?arch=arm64">Mac Agent</a>
          <a href="/v2">Open legacy /v2</a>
          <a href="/api/auth/logout">Sign out</a>
        </div>
      )}
    </>
  );
}
