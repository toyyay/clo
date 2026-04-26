import type { SessionInfo } from "../../packages/shared/types";

const REDACTED_RE = /^<redacted(?:[:\s][^>]*)?>$/i;

export function shortId(value: string, size = 8) {
  return value.length <= size ? value : value.slice(0, size);
}

export function providerFilterValue(session: SessionInfo) {
  return session.sourceProvider || (session.id.startsWith("v3:") ? "v3" : "legacy");
}

export function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "legacy") return "Legacy";
  if (provider === "v3") return "V3";
  if (provider === "unknown") return "Unknown";
  return provider.slice(0, 1).toUpperCase() + provider.slice(1);
}

export function sourceProviderLabel(session: SessionInfo) {
  return providerLabel(providerFilterValue(session));
}

export function sourceGenerationLabel(session: SessionInfo) {
  return session.sourceGeneration ? `g${session.sourceGeneration}` : null;
}

export function projectFilterValue(session: SessionInfo) {
  return session.projectKey || session.projectName || "unknown";
}

export function projectLabel(session: SessionInfo) {
  return session.projectName || session.projectKey || "Unknown";
}

export function sessionDisplayTitle(session: SessionInfo) {
  if (session.title && !isRedactedValue(session.title)) return session.title;
  if (session.sessionId && !isRedactedValue(session.sessionId)) return session.sessionId;
  return titleFromCodexPath(session.sourcePath) ?? titleFromPath(session.sourcePath) ?? shortId(session.id);
}

export function sessionActivityLabel(session: SessionInfo, now = Date.now()) {
  return relativeTime(sessionActivityTimestamp(session), now);
}

export function relativeActivityLabel(value?: string | null, now = Date.now()) {
  return relativeTime(value, now);
}

export function sessionActivityDateLabel(session: SessionInfo) {
  return formatDateTime(sessionActivityTimestamp(session), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function sessionActivityTitle(session: SessionInfo) {
  const sourceModified = formatDateTime(sourceModifiedTimestamp(session));
  const lastSeen = formatDateTime(session.lastSeenAt);
  const firstSeen = formatDateTime(session.firstSeenAt);
  const sourceDate = formatDateTime(timestampFromPath(session.sourcePath));
  return [
    sourceModified ? `Source changed: ${sourceModified}` : null,
    lastSeen ? `Last synced: ${lastSeen}` : null,
    firstSeen ? `First seen: ${firstSeen}` : null,
    sourceDate ? `Source date: ${sourceDate}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function sessionActivityTimestamp(session: SessionInfo) {
  return sourceModifiedTimestamp(session) || session.lastSeenAt || timestampFromPath(session.sourcePath);
}

export function sessionArchiveLabel(session: SessionInfo) {
  return session.deletedAt ? "Archived" : "Active";
}

export function hostLabel(hostname: string, agentId: string, duplicateHostnames: Set<string>) {
  return duplicateHostnames.has(hostname) ? `${hostname} · ${shortId(agentId)}` : hostname;
}

export function sessionSourceTitle(session: SessionInfo) {
  return [
    `Provider: ${sourceProviderLabel(session)}`,
    `Title: ${sessionDisplayTitle(session)}`,
    `Project: ${projectLabel(session)}`,
    `Host: ${session.hostname}`,
    `Agent: ${session.agentId}`,
    session.sourceGeneration ? `Generation: ${session.sourceGeneration}` : null,
    session.lastSeenAt ? `Last changed: ${formatDateTime(session.lastSeenAt)}` : null,
    `Source: ${session.sourcePath}`,
    session.gitBranch ? `Git: ${session.gitBranch}${session.gitCommit ? ` @ ${shortId(session.gitCommit, 10)}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function isRedactedValue(value: string) {
  return REDACTED_RE.test(value.trim());
}

function titleFromCodexPath(path: string) {
  const match = path.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `Codex ${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function titleFromPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const filename = parts[parts.length - 1];
  return filename ? filename.replace(/\.[^.]+$/, "") : null;
}

function timestampFromPath(path: string) {
  const match = path.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function sourceModifiedTimestamp(session: SessionInfo) {
  if (!session.id.startsWith("v3:")) return null;
  if (!Number.isFinite(session.mtimeMs) || session.mtimeMs <= 0) return null;
  return new Date(session.mtimeMs).toISOString();
}

function relativeTime(value?: string | null, now = Date.now()) {
  const parsed = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return "";
  const diffMs = Math.max(0, now - parsed);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`;
  if (diffMs < day * 7) return `${Math.floor(diffMs / day)}d`;
  return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateTime(value?: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleString(undefined, options);
}
