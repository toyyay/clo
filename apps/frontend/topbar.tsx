import type { SessionInfo } from "../../packages/shared/types";
import type { SyncHealth, SyncState } from "./app-types";
import { InterfacePrefsPopover } from "./interface-prefs-popover";
import {
  projectLabel,
  relativeActivityLabel,
  sessionActivityLabel,
  sessionActivityTitle,
  sessionDisplayTitle,
  sessionSourceTitle,
  sourceProviderLabel,
} from "./session-utils";
import type { InterfacePrefs } from "./storage-prefs";

type TopbarProps = {
  active: SessionInfo | null;
  syncState: SyncState;
  statusText: string;
  syncHealth: SyncHealth;
  now: number;
  theme: "light" | "dark";
  interfacePrefs: InterfacePrefs;
  interfacePrefsOpen: boolean;
  updateReady: boolean;
  onToggleSidebar: () => void;
  onToggleInterfacePrefs: () => void;
  onCloseInterfacePrefs: () => void;
  onInterfacePrefsChange: (patch: Partial<InterfacePrefs>) => void;
  onResetInterfacePrefs: () => void;
  onUpdate: () => void;
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
  interfacePrefs,
  interfacePrefsOpen,
  updateReady,
  onToggleSidebar,
  onToggleInterfacePrefs,
  onCloseInterfacePrefs,
  onInterfacePrefsChange,
  onResetInterfacePrefs,
  onUpdate,
  onOpenAudio,
  onOpenSettings,
  onSync,
  onToggleTheme,
  onLogout,
}: TopbarProps) {
  const healthClass = syncHealth.online ? (syncState === "error" ? "error" : "online") : "offline";
  const detailText = syncDetailLabel(syncState, syncHealth, now);
  const title = syncTitle(syncHealth);
  const shortSync = syncShortLabel(syncState, syncHealth);

  return (
    <header className="topbar">
      <button className="top-chat-toggle" onClick={onToggleSidebar} title="Toggle chats" aria-label="Toggle chats">
        ☰
      </button>
      <div className="top-chat-summary" title={active ? sessionSourceTitle(active) : "No cached chats yet"}>
        {active ? (
          <>
            <div className="top-chat-title">{sessionDisplayTitle(active)}</div>
            <div className="top-chat-micro">
              <span>{compactActivityLabel(active, now)}</span>
              <span>{formatEventCount(active.eventCount)}</span>
              <span>{formatBytes(active.sizeBytes)}</span>
              <span>{sourceProviderLabel(active)}</span>
              <span>{projectLabel(active)}</span>
            </div>
          </>
        ) : (
          <div className="top-chat-title empty-title">No chats</div>
        )}
      </div>
      <details className="sync-popover-wrap">
        <summary className={`sync-pill ${syncState}`} title={title} aria-label="Sync details">
          <span className={`sync-dot ${healthClass}`} />
          <span>{shortSync}</span>
        </summary>
        <div className="sync-popover" role="status">
          <div>
            <b>{statusText}</b>
            <span>{detailText}</span>
          </div>
          <dl>
            <dt>Browser</dt>
            <dd>{syncHealth.online ? "online" : "offline"}</dd>
            <dt>Attempt</dt>
            <dd>{formatDateTime(syncHealth.lastAttemptAt)}</dd>
            <dt>Success</dt>
            <dd>{formatDateTime(syncHealth.lastSuccessAt)}</dd>
            <dt>Cache</dt>
            <dd>{syncHealth.online ? "live + local" : "local only"}</dd>
            {syncHealth.lastError && (
              <>
                <dt>Error</dt>
                <dd>{syncHealth.lastError}</dd>
              </>
            )}
          </dl>
        </div>
      </details>
      <div className="top-actions">
        <InterfacePrefsPopover
          open={interfacePrefsOpen}
          prefs={interfacePrefs}
          onToggle={onToggleInterfacePrefs}
          onClose={onCloseInterfacePrefs}
          onChange={onInterfacePrefsChange}
          onReset={onResetInterfacePrefs}
        />
        <details className="top-more">
          <summary className="icon-button top-more-summary" aria-label="More actions">⋯</summary>
          <div className="top-more-menu">
            {updateReady && (
              <button className="icon-button update-menu-button" onClick={onUpdate}>
                обновить
              </button>
            )}
            <button className="icon-button" onClick={onSync} disabled={syncState === "syncing"} title="Sync now">
              Sync now
            </button>
            <button className="icon-button" onClick={onOpenAudio} title="Uploaded audio">
              Audio
            </button>
            <button className="icon-button" onClick={onOpenSettings} title="Settings">
              Settings
            </button>
            <a className="icon-button download-button" href="/api/agent/download?arch=arm64">
              Mac Agent
            </a>
            <button className="icon-button" onClick={onToggleTheme} title="Toggle theme">
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button className="icon-button" onClick={onLogout} title="Sign out">
              Logout
            </button>
          </div>
        </details>
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

function syncShortLabel(syncState: SyncState, syncHealth: SyncHealth) {
  if (!syncHealth.online) return "off";
  if (syncState === "syncing") return "sync";
  if (syncState === "error") return "err";
  if (syncState === "loading") return "load";
  return "ok";
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

function formatEventCount(value?: number | null) {
  const count = Math.max(0, value ?? 0);
  if (count >= 1000) return `${Math.round(count / 100) / 10}k msg`;
  return `${count} msg`;
}

function formatBytes(value?: number | null) {
  const bytes = Math.max(0, value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return new Date(parsed).toLocaleString();
}

function compactActivityLabel(session: SessionInfo, now: number) {
  const compactDate = formatCompactDate(sessionActivityTimestamp(session));
  const relative = sessionActivityLabel(session, now);
  return [compactDate, relative].filter(Boolean).join(" ");
}

function formatCompactDate(value?: string | null) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString(undefined, { month: "short" }).toLowerCase().replace(/\.$/, "");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${day}${month} ${hour}:${minute}`;
}

function sessionActivityTimestamp(session: SessionInfo) {
  if (session.id.startsWith("v3:") && Number.isFinite(session.mtimeMs) && session.mtimeMs > 0) {
    return new Date(session.mtimeMs).toISOString();
  }
  return session.lastSeenAt || timestampFromPath(session.sourcePath);
}

function timestampFromPath(path: string) {
  const match = path.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}
