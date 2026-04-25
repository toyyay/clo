import type { SessionInfo } from "../../packages/shared/types";
import type { SyncState } from "./app-types";

type TopbarProps = {
  active: SessionInfo | null;
  syncState: SyncState;
  statusText: string;
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
  theme,
  onToggleSidebar,
  onOpenAudio,
  onOpenSettings,
  onSync,
  onToggleTheme,
  onLogout,
}: TopbarProps) {
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
        <div className={`sync-line ${syncState}`}>{statusText}</div>
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
