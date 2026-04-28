import type { AgentV2Identity, ProviderKind, SyncPolicy } from "./types";

const DEFAULT_IGNORE_PATTERNS = [
  ".git",
  "node_modules",
  ".DS_Store",
  "dist",
  "build",
  "tmp",
  "temp",
  "*.tmp",
  "*.swp",
  "*.lock",
];

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  enabled: true,
  uploadsEnabled: false,
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadChunkBytes: 256 * 1024,
  maxUploadLines: 250,
  scanRoots: ["claude", "codex", "gemini"],
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  source: "default",
};

export type FetchSyncPolicyOptions = {
  backendUrl: string;
  token?: string;
  identity: AgentV2Identity;
  takeover?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type AgentRuntimeInfo = {
  runtimeId?: string;
  agentId?: string;
  hostname?: string;
  pid?: number | null;
  startedAt?: string | null;
  lastSeenAt?: string | null;
  status?: string;
};

export type AgentRuntimeControl = {
  action?: "continue" | "shutdown" | "reject";
  reason?: string;
  activeRuntimes?: AgentRuntimeInfo[];
};

export class AgentRuntimeRejectedError extends Error {
  control?: AgentRuntimeControl;

  constructor(message: string, control?: AgentRuntimeControl) {
    super(message);
    this.name = "AgentRuntimeRejectedError";
    this.control = control;
  }
}

export class AgentShutdownRequestedError extends Error {
  control?: AgentRuntimeControl;

  constructor(message: string, control?: AgentRuntimeControl) {
    super(message);
    this.name = "AgentShutdownRequestedError";
    this.control = control;
  }
}

export async function fetchServerSyncPolicy(options: FetchSyncPolicyOptions): Promise<SyncPolicy> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${trimSlash(options.backendUrl)}/api/agent/v1/hello`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        agent: options.identity,
        runtime: {
          runtimeId: options.identity.runtimeId,
          pid: options.identity.pid,
          startedAt: options.identity.startedAt,
          ...(options.takeover ? { takeover: true } : {}),
        },
        ...(options.takeover ? { control: { takeover: true } } : {}),
        capabilities: {
          inventory: true,
          appendJsonlCursors: true,
          chunkedUploads: true,
          providers: DEFAULT_SYNC_POLICY.scanRoots,
        },
      }),
    });
    const payload = await readJsonObject(response);
    const control = normalizeRuntimeControl(payload?.control);
    if (!response.ok) {
      if (response.status === 409 || control?.action === "reject") {
        throw new AgentRuntimeRejectedError(runtimeErrorMessage("agent runtime rejected by server", control), control);
      }
      return DEFAULT_SYNC_POLICY;
    }
    if (control?.action === "shutdown") {
      throw new AgentShutdownRequestedError(runtimeErrorMessage("agent shutdown requested by server", control), control);
    }
    return normalizeServerPolicy(payload?.policy ?? payload);
  } catch (error) {
    if (error instanceof AgentRuntimeRejectedError || error instanceof AgentShutdownRequestedError) throw error;
    return DEFAULT_SYNC_POLICY;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeServerPolicy(value: unknown): SyncPolicy {
  if (!value || typeof value !== "object") return DEFAULT_SYNC_POLICY;
  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SYNC_POLICY.enabled,
    uploadsEnabled: typeof record.uploadsEnabled === "boolean" ? record.uploadsEnabled : DEFAULT_SYNC_POLICY.uploadsEnabled,
    maxFileBytes: positiveNumber(record.maxFileBytes, DEFAULT_SYNC_POLICY.maxFileBytes),
    maxUploadChunkBytes: positiveNumber(
      record.maxUploadChunkBytes ?? objectField(record.requestLimits)?.rawChunkBytes,
      DEFAULT_SYNC_POLICY.maxUploadChunkBytes,
    ),
    maxUploadLines: positiveNumber(record.maxUploadLines, DEFAULT_SYNC_POLICY.maxUploadLines),
    scanRoots: providerList(record.scanRoots ?? record.providers, DEFAULT_SYNC_POLICY.scanRoots),
    ignorePatterns: stringList(record.ignorePatterns, DEFAULT_SYNC_POLICY.ignorePatterns),
    source: "server",
  };
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function providerList(value: unknown, fallback: ProviderKind[]): ProviderKind[] {
  const providers = stringList(value, []).filter((item): item is ProviderKind =>
    item === "claude" || item === "codex" || item === "gemini",
  );
  return providers.length ? providers : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length ? list : fallback;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeRuntimeControl(value: unknown): AgentRuntimeControl | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const action = record.action === "continue" || record.action === "shutdown" || record.action === "reject" ? record.action : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const activeRuntimes = Array.isArray(record.activeRuntimes)
    ? record.activeRuntimes
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          runtimeId: typeof item.runtimeId === "string" ? item.runtimeId : undefined,
          agentId: typeof item.agentId === "string" ? item.agentId : undefined,
          hostname: typeof item.hostname === "string" ? item.hostname : undefined,
          pid: typeof item.pid === "number" ? item.pid : item.pid === null ? null : undefined,
          startedAt: typeof item.startedAt === "string" ? item.startedAt : item.startedAt === null ? null : undefined,
          lastSeenAt: typeof item.lastSeenAt === "string" ? item.lastSeenAt : item.lastSeenAt === null ? null : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
        }))
    : undefined;
  return { action, reason, activeRuntimes };
}

function runtimeErrorMessage(prefix: string, control?: AgentRuntimeControl) {
  const runtimes = (control?.activeRuntimes ?? [])
    .map((runtime) => {
      const pid = runtime.pid == null ? "pid unknown" : `pid ${runtime.pid}`;
      return [runtime.runtimeId, runtime.hostname, pid].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(", ");
  return [prefix, control?.reason, runtimes ? `active: ${runtimes}` : ""].filter(Boolean).join("; ");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
