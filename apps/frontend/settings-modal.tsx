import type { ReactElement } from "react";
import type { AppSettingsInfo } from "../../packages/shared/types";
import type { CacheStats } from "./db";

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function formatLimit(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unlimited";
}

function openRouterStatusLabel(settings: AppSettingsInfo | null) {
  const status = settings?.openRouter.status;
  if (status === "ok") return "ready";
  if (status === "checking") return "checking";
  if (status === "error") return "error";
  return "missing";
}

function ModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactElement | ReactElement[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button compact-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SettingsModal({
  settings,
  cacheStats,
  loading,
  message,
  onClose,
  onRefresh,
  onCopy,
  onCreateToken,
  onCheckOpenRouter,
  onResetIndexedDb,
  onClearCaches,
  onUnregisterServiceWorkers,
  groupByProject,
  sidebarWidth,
  onGroupByProjectChange,
  onResetSidebarWidth,
}: {
  settings: AppSettingsInfo | null;
  cacheStats: CacheStats | null;
  loading: boolean;
  message: string;
  onClose: () => void;
  onRefresh: () => void;
  onCopy: (value: string) => void;
  onCreateToken: () => void;
  onCheckOpenRouter: () => void;
  onResetIndexedDb: () => void;
  onClearCaches: () => void;
  onUnregisterServiceWorkers: () => void;
  groupByProject: boolean;
  sidebarWidth: number;
  onGroupByProjectChange: (value: boolean) => void;
  onResetSidebarWidth: () => void;
}) {
  const openRouter = settings?.openRouter;
  const openRouterReady = openRouter?.status === "ok";
  const openRouterKey = openRouter?.key;
  return (
    <ModalFrame title="Settings" onClose={onClose}>
      <div className="modal-body">
        <div className="settings-section">
          <div className="section-title">iPhone Upload</div>
          {settings?.importTokens.length ? (
            <div className="url-list">
              {settings.importTokens.map((token) => (
                <div className="url-row" key={token.id}>
                  <div className="url-meta">
                    <span>{token.label}</span>
                    <span>{token.tokenPreview} / last used {formatDate(token.lastUsedAt)}</span>
                  </div>
                  <code>{token.uploadUrl}</code>
                  <button className="icon-button compact-button" onClick={() => onCopy(token.uploadUrl)}>
                    Copy
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-text">No import tokens yet.</div>
          )}
          <button className="icon-button" onClick={onCreateToken} disabled={loading}>
            New token
          </button>
        </div>

        <div className="settings-section">
          <div className="section-title">OpenRouter</div>
          <div className={`service-status ${openRouterStatusLabel(settings)}`}>
            <span>{openRouterStatusLabel(settings)}</span>
            <b>{openRouter?.message ?? "OPENROUTER_API_KEY is not configured"}</b>
          </div>
          <div className="kv-grid">
            <span>Configured</span>
            <b>{openRouter?.configured ? "yes" : "no"}</b>
            <span>Model</span>
            <b>{openRouter?.model ?? "unknown"}</b>
            <span>Reasoning</span>
            <b>{openRouter?.reasoningEffort ?? "medium"}</b>
            <span>Key label</span>
            <b>{openRouterKey?.label ?? (openRouter?.configured ? "unknown" : "missing")}</b>
            <span>Limit remaining</span>
            <b>{openRouterReady ? formatLimit(openRouterKey?.limitRemaining) : "not available"}</b>
            <span>Usage</span>
            <b>{openRouterReady ? formatNumber(openRouterKey?.usage) : "not available"}</b>
            <span>Rate limit</span>
            <b>
              {typeof openRouterKey?.rateLimit?.requests === "number" && openRouterKey.rateLimit.requests > 0
                ? `${openRouterKey.rateLimit.requests.toLocaleString()} / ${openRouterKey.rateLimit.interval ?? "window"}`
                : "not available"}
            </b>
            <span>Checked</span>
            <b>{formatDate(openRouter?.checkedAt)}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onCheckOpenRouter} disabled={loading}>
              Check OpenRouter
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Interface</div>
          <label className="toggle-row">
            <input type="checkbox" checked={groupByProject} onChange={(event) => onGroupByProjectChange(event.target.checked)} />
            <span>
              <b>Group chats by project</b>
            </span>
          </label>
          <div className="kv-grid">
            <span>Sidebar width</span>
            <b>{sidebarWidth}px</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onResetSidebarWidth}>
              Reset sidebar width
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Cache</div>
          <div className="kv-grid">
            <span>Storage</span>
            <b>
              {formatBytes(cacheStats?.storageUsageBytes)} / {formatBytes(cacheStats?.storageQuotaBytes)}
            </b>
            <span>IndexedDB</span>
            <b>{cacheStats ? Object.entries(cacheStats.indexedDb).map(([k, v]) => `${k}:${v}`).join(" ") : "loading"}</b>
            <span>Cache API</span>
            <b>{cacheStats?.cacheNames.length ?? 0}</b>
            <span>Service workers</span>
            <b>{cacheStats?.serviceWorkers ?? 0}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onRefresh} disabled={loading}>
              Refresh
            </button>
            <button className="icon-button" onClick={onResetIndexedDb} disabled={loading}>
              Reset IndexedDB
            </button>
            <button className="icon-button" onClick={onClearCaches} disabled={loading}>
              Clear caches
            </button>
            <button className="icon-button" onClick={onUnregisterServiceWorkers} disabled={loading}>
              Reset service workers
            </button>
          </div>
        </div>

        {message && <div className="modal-message">{message}</div>}
      </div>
    </ModalFrame>
  );
}
