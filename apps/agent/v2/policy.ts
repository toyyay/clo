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
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

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
        capabilities: {
          inventory: true,
          appendJsonlCursors: true,
          chunkedUploads: true,
          providers: DEFAULT_SYNC_POLICY.scanRoots,
        },
      }),
    });
    if (!response.ok) return DEFAULT_SYNC_POLICY;
    const payload = await response.json();
    return normalizeServerPolicy(payload?.policy ?? payload);
  } catch {
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

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
