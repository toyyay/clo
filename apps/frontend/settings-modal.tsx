import type { ReactElement } from "react";
import type { AppSettingsInfo, SyncExclusionInfo, SyncExclusionKind } from "../../packages/shared/types";
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

function formatCacheRecords(cacheStats: CacheStats | null) {
  if (!cacheStats) return "loading";
  const total = Object.values(cacheStats.indexedDb).reduce((sum, value) => sum + value, 0);
  return `${total.toLocaleString()} records, ${cacheStats.indexedDb.events.toLocaleString()} events`;
}

function formatMutedKind(kind: SyncExclusionKind) {
  if (kind === "device") return "Device";
  if (kind === "provider") return "Provider";
  return "Chat";
}

function formatMutedMeta(exclusion: SyncExclusionInfo) {
  const sessionCount = numberMeta(exclusion.metadata.sessionCount);
  const eventCount = numberMeta(exclusion.metadata.eventCount);
  const bytes = numberMeta(exclusion.metadata.approxBytes);
  const parts = [];
  if (sessionCount) parts.push(`${sessionCount.toLocaleString()} chats`);
  if (eventCount) parts.push(`${eventCount.toLocaleString()} events`);
  if (bytes) parts.push(formatBytes(bytes));
  return parts.length ? parts.join(" / ") : exclusion.targetId;
}

function numberMeta(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function openRouterStatusLabel(settings: AppSettingsInfo | null) {
  const status = settings?.openRouter.status;
  if (status === "ok") return "ready";
  if (status === "checking") return "checking";
  if (status === "error") return "error";
  return "missing";
}

function openRouterSummary(settings: AppSettingsInfo | null) {
  const openRouter = settings?.openRouter;
  const configured = openRouter?.configured ? "configured" : "not configured";
  const model = openRouter?.model ?? "unknown model";
  const reasoning = openRouter?.reasoningEffort ?? "medium";
  return `${configured} / ${model} / ${reasoning}`;
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
  mutedSources,
  mutedSummary,
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
  onRestoreMutedSource,
  groupByProject,
  sidebarWidth,
  retentionDays,
  onGroupByProjectChange,
  onResetSidebarWidth,
  onRetentionDaysChange,
}: {
  settings: AppSettingsInfo | null;
  cacheStats: CacheStats | null;
  mutedSources: SyncExclusionInfo[];
  mutedSummary: Record<SyncExclusionKind, number> & { approxBytes: number; eventCount: number; sessionCount: number };
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
  onRestoreMutedSource: (id: string) => void;
  groupByProject: boolean;
  sidebarWidth: number;
  retentionDays: number;
  onGroupByProjectChange: (value: boolean) => void;
  onResetSidebarWidth: () => void;
  onRetentionDaysChange: (value: number) => void;
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
            <b>
              {openRouter?.message ?? "OPENROUTER_API_KEY is not configured"}
              <small>{openRouterSummary(settings)}</small>
            </b>
          </div>
          <div className="settings-actions settings-actions-tight">
            <button className="icon-button" onClick={onCheckOpenRouter} disabled={loading}>
              Check OpenRouter
            </button>
            <details className="settings-details">
              <summary>Details</summary>
              <div className="kv-grid kv-grid-compact">
                <span>Key</span>
                <b>{openRouterKey?.label ?? (openRouter?.configured ? "unknown" : "missing")}</b>
                <span>Limit</span>
                <b>{openRouterReady ? formatLimit(openRouterKey?.limitRemaining) : "not available"}</b>
                <span>Usage</span>
                <b>{openRouterReady ? formatNumber(openRouterKey?.usage) : "not available"}</b>
                <span>Rate</span>
                <b>
                  {typeof openRouterKey?.rateLimit?.requests === "number" && openRouterKey.rateLimit.requests > 0
                    ? `${openRouterKey.rateLimit.requests.toLocaleString()} / ${openRouterKey.rateLimit.interval ?? "window"}`
                    : "not available"}
                </b>
                <span>Checked</span>
                <b>{formatDate(openRouter?.checkedAt)}</b>
              </div>
            </details>
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
          <div className="kv-grid kv-grid-compact">
            <span>Sidebar width</span>
            <b>{sidebarWidth}px</b>
          </div>
          <label className="settings-range">
            <span>
              <b>Keep chats</b>
              <output>{retentionDays.toLocaleString()} days</output>
            </span>
            <input
              type="range"
              min={1}
              max={180}
              step={1}
              value={retentionDays}
              onChange={(event) => onRetentionDaysChange(Number(event.target.value))}
            />
            <input
              type="number"
              min={1}
              max={180}
              step={1}
              value={retentionDays}
              onChange={(event) => onRetentionDaysChange(Number(event.target.value))}
              aria-label="Retention days"
            />
          </label>
          <div className="kv-grid kv-grid-compact">
            <span>Local window</span>
            <b>
              {formatCacheRecords(cacheStats)} / {formatBytes(cacheStats?.storageUsageBytes)}
            </b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onResetSidebarWidth}>
              Reset sidebar width
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Muted</div>
          <div className="kv-grid kv-grid-compact">
            <span>Sources</span>
            <b>
              {mutedSummary.device.toLocaleString()} devices / {mutedSummary.provider.toLocaleString()} providers / {mutedSummary.session.toLocaleString()} chats
            </b>
            <span>Cached weight</span>
            <b>
              {mutedSummary.sessionCount.toLocaleString()} chats / {mutedSummary.eventCount.toLocaleString()} events / {formatBytes(mutedSummary.approxBytes)}
            </b>
          </div>
          {mutedSources.length ? (
            <div className="url-list muted-list">
              {mutedSources.map((source) => (
                <div className="url-row muted-row" key={source.id}>
                  <div className="url-meta">
                    <span>{source.label ?? source.targetId}</span>
                    <span>
                      {formatMutedKind(source.kind)} / {formatMutedMeta(source)}
                    </span>
                  </div>
                  <button className="icon-button compact-button" onClick={() => onRestoreMutedSource(source.id)} disabled={loading}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-text">Nothing muted.</div>
          )}
        </div>

        <div className="settings-section">
          <div className="section-title">Cache</div>
          <div className="kv-grid kv-grid-compact">
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
              Reset all local data
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
