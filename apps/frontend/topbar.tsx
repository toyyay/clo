import type { SessionInfo } from "../../packages/shared/types";
import type { SyncHealth, SyncState } from "./app-types";
import { relativeActivityLabel } from "./session-utils";

type TopbarProps = {
  active: SessionInfo | null;
  syncState: SyncState;
  statusText: string;
  syncHealth: SyncHealth;
  now: number;
  theme: "light" | "dark";
  onToggleSidebar: () => void;
  onOpenAudio: () => void;
  onOpenSettings: () => void;
  onSync: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
};

export function Topbar({
  active,
  syncState,
  statusText,
  syncHealth,
  now,
  theme,
  onToggleSidebar,
  onOpenAudio,
  onOpenSettings,
  onSync,
  onToggleTheme,
  onLogout,
}: TopbarProps) {
  const healthClass = syncHealth.online ? (syncState === "error" ? "error" : "online") : "offline";
  const detailText = syncDetailLabel(syncState, syncHealth, now);
  const title = syncTitle(syncHealth);

  return (
    <header className="topbar">
      <div className="top-left">
        <button className="icon-button menu-button" onClick={onToggleSidebar} title="Toggle chats">
          Chats
        </button>
        <div>
          <div className="brand">Chatview</div>
          {active && (
            <div className="active-inline">
              {active.hostname} / {active.projectName}
            </div>
          )}
        </div>
      </div>
      <div className="top-status">
        <div className={`sync-line ${syncState}`} title={title} aria-live="polite">
          <span className={`sync-dot ${healthClass}`} />
          <span className="sync-main">{statusText}</span>
          <span className="sync-detail">{detailText}</span>
        </div>
      </div>
      <div className="top-actions">
        <button className="icon-button" onClick={onOpenAudio} title="Uploaded audio">
          Audio
        </button>
        <button className="icon-button" onClick={onOpenSettings} title="Settings">
          Settings
        </button>
        <a className="icon-button download-button" href="/api/agent/download?arch=arm64">
          Download Mac Agent (M1)
        </a>
        <button className="icon-button" onClick={onSync} disabled={syncState === "syncing"} title="Sync now">
          Sync
        </button>
        <button className="icon-button" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <button className="icon-button" onClick={onLogout} title="Sign out">
          Logout
        </button>
      </div>
    </header>
  );
}

function syncDetailLabel(syncState: SyncState, syncHealth: SyncHealth, now: number) {
  if (!syncHealth.online) return "Offline · cache only";
  const checked = syncHealth.lastSuccessAt ? `checked ${relativeActivityLabel(syncHealth.lastSuccessAt, now) || "now"}` : "not checked";
  if (syncState === "syncing") return `Syncing · ${checked}`;
  if (syncState === "loading") return "Loading local cache";
  if (syncState === "error") return `Backend issue · ${checked}`;
  return `Online · ${checked}`;
}

function syncTitle(syncHealth: SyncHealth) {
  return [
    `Browser: ${syncHealth.online ? "online" : "offline"}`,
    syncHealth.lastAttemptAt ? `Last attempt: ${new Date(syncHealth.lastAttemptAt).toLocaleString()}` : null,
    syncHealth.lastSuccessAt ? `Last success: ${new Date(syncHealth.lastSuccessAt).toLocaleString()}` : null,
    syncHealth.lastError ? `Last error: ${syncHealth.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
