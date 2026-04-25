import { homedir } from "node:os";
import { join } from "node:path";
import { envPositiveInteger, envValue, type EnvSource } from "../../../packages/shared/env";
import { AGENT_V1_ENDPOINTS } from "../../../packages/contracts";
import { readAppendJsonl } from "./cursor";
import { scanInventory } from "./inventory";
import { DEFAULT_SYNC_POLICY, fetchServerSyncPolicy } from "./policy";
import { executeUploadPlan, planUploadChunks } from "./planner";
import { parseRootSpec, rootsFromEnv } from "./roots";
import { identityForAgentV2, loadAgentV2State, saveAgentV2State } from "./state";
import { buildAgentV1AppendRequest } from "./upload";
import type { AgentV2Identity, SyncPolicy, SyncRootConfig, TailBatch, UploadChunk, UploadTransport } from "./types";

declare const CHATVIEW_EMBEDDED_BACKEND_URL: string | undefined;
declare const CHATVIEW_EMBEDDED_AGENT_TOKEN: string | undefined;

const DEFAULT_BACKEND_URL =
  typeof CHATVIEW_EMBEDDED_BACKEND_URL !== "undefined" ? CHATVIEW_EMBEDDED_BACKEND_URL : "https://clo.vf.lc";
const DEFAULT_AGENT_TOKEN = typeof CHATVIEW_EMBEDDED_AGENT_TOKEN !== "undefined" ? CHATVIEW_EMBEDDED_AGENT_TOKEN : "";
const DEFAULT_STATE_PATH = join(homedir(), ".chatview-agent", "v2-state.json");
const DEFAULT_APPEND_PATH = AGENT_V1_ENDPOINTS.append;

export type AgentV2RunOptions = {
  roots?: SyncRootConfig[];
  statePath: string;
  backendUrl: string;
  token?: string;
  pollMs?: number;
  readChunkBytes?: number;
  appendPath?: string;
  fetchPolicy?: boolean;
  logIdleEveryScans?: number;
  once?: boolean;
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, "log" | "error">;
};

export type AgentV2ScanSummary = {
  agentId: string;
  policySource: SyncPolicy["source"];
  uploadsEnabled: boolean;
  roots: SyncRootConfig[];
  fileCount: number;
  pendingRecordCount: number;
  plannedChunkCount: number;
  uploadedChunkCount: number;
  skippedCount: number;
};

export async function runAgentV2(options: AgentV2RunOptions): Promise<void> {
  if (!options.token) throw new Error("AGENT_TOKEN or --token is required");
  const log = options.log ?? console;
  const pollMs = options.pollMs ?? 2000;
  const logIdleEveryScans = options.logIdleEveryScans ?? 30;
  let scanCount = 0;

  log.log(
    `[agent-v2] starting; backend ${trimSlash(options.backendUrl)}, state ${options.statePath}, poll ${pollMs}ms`,
  );

  do {
    try {
      const summary = await scanAndUploadAgentV2(options);
      scanCount += 1;
      const hasActivity =
        summary.uploadedChunkCount > 0 ||
        summary.plannedChunkCount > 0 ||
        summary.pendingRecordCount > 0 ||
        summary.skippedCount > 0 ||
        !summary.uploadsEnabled;
      const shouldLogIdle = logIdleEveryScans > 0 && scanCount % logIdleEveryScans === 0;
      if (options.once || hasActivity || shouldLogIdle) {
        log.log(formatAgentV2Summary(summary, hasActivity ? "activity" : "idle"));
        if (summary.skippedCount) log.log(`[agent-v2] skipped ${summary.skippedCount} item(s)`);
      }
    } catch (error) {
      log.error(`[agent-v2] ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.once) break;
    await sleep(pollMs);
  } while (true);
}

export async function scanAndUploadAgentV2(options: AgentV2RunOptions): Promise<AgentV2ScanSummary> {
  if (!options.token) throw new Error("AGENT_TOKEN or --token is required");

  const state = await loadAgentV2State(options.statePath);
  const identity = identityForAgentV2(state);
  const roots = options.roots ?? rootsFromEnv(options.env);
  const shouldFetchPolicy = options.fetchPolicy !== false;
  const policy = shouldFetchPolicy
    ? await fetchServerSyncPolicy({
        backendUrl: options.backendUrl,
        token: options.token,
        identity,
        fetchImpl: options.fetchImpl,
      })
    : DEFAULT_SYNC_POLICY;

  if (!policy.enabled) {
    await saveAgentV2State(options.statePath, state);
    return emptySummary(state.agentId, policy, roots);
  }

  const files = await scanInventory(
    roots.filter((root) => policy.scanRoots.includes(root.provider)),
    policy.ignorePatterns,
  );
  const batches: TailBatch[] = [];
  const readChunkBytes = options.readChunkBytes ?? policy.maxUploadChunkBytes;

  for (const file of files) {
    if (file.sizeBytes > policy.maxFileBytes) continue;
    const batch = await readAppendJsonl(file, state.cursors[file.sourcePath], { readChunkBytes });
    batches.push(batch);
  }

  const plan = planUploadChunks(files, batches, policy);
  if (!policy.uploadsEnabled) {
    await saveAgentV2State(options.statePath, state);
    return {
      agentId: state.agentId,
      policySource: policy.source,
      uploadsEnabled: false,
      roots,
      fileCount: files.length,
      pendingRecordCount: countPendingRecords(batches),
      plannedChunkCount: plan.chunks.length,
      uploadedChunkCount: 0,
      skippedCount: plan.skipped.length,
    };
  }

  const transport = createAgentV2UploadTransport({
    backendUrl: options.backendUrl,
    token: options.token,
    appendPath: options.appendPath,
    identity,
    fetchImpl: options.fetchImpl,
  });
  await executeUploadPlan(plan, transport);
  const uploadedSourcePaths = new Set(plan.chunks.map((chunk) => chunk.sourcePath));

  for (const batch of batches) {
    if (!uploadedSourcePaths.has(batch.file.sourcePath) && batch.records.length) continue;
    state.cursors[batch.file.sourcePath] = batch.nextCursor;
    if (state.previewCursors) delete state.previewCursors[batch.file.sourcePath];
  }
  await saveAgentV2State(options.statePath, state);

  return {
    agentId: state.agentId,
    policySource: policy.source,
    uploadsEnabled: true,
    roots,
    fileCount: files.length,
    pendingRecordCount: countPendingRecords(batches),
    plannedChunkCount: plan.chunks.length,
    uploadedChunkCount: plan.chunks.length,
    skippedCount: plan.skipped.length,
  };
}

export function createAgentV2UploadTransport(options: {
  backendUrl: string;
  token: string;
  appendPath?: string;
  identity: AgentV2Identity;
  fetchImpl?: typeof fetch;
}): UploadTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appendUrl = `${trimSlash(options.backendUrl)}${normalizePath(options.appendPath ?? DEFAULT_APPEND_PATH)}`;

  return {
    async uploadChunk(chunk: UploadChunk) {
      const response = await fetchWithRetry(
        appendUrl,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildAgentV1AppendRequest(options.identity, chunk)),
        },
        fetchImpl,
      );
      if (!response.ok) {
        throw new Error(`v2 append failed for ${chunk.sourcePath}: ${response.status} ${await response.text()}`);
      }
    },
  };
}

export async function runAgentV2FromCli(argv: string[], overrides: Partial<AgentV2RunOptions> = {}) {
  const options = { ...parseAgentV2RunArgs(argv), ...overrides };
  await runAgentV2(options);
}

export function parseAgentV2RunArgs(argv: string[], env: EnvSource = process.env): AgentV2RunOptions {
  const roots: SyncRootConfig[] = [];
  let statePath = envValue(env, "AGENT_STATE", "CHATVIEW_AGENT_STATE") ?? DEFAULT_STATE_PATH;
  let backendUrl = envValue(env, "BACKEND_URL", "CHATVIEW_BACKEND_URL") ?? DEFAULT_BACKEND_URL;
  let token = envValue(env, "AGENT_TOKEN", "CHATVIEW_AGENT_TOKEN") ?? DEFAULT_AGENT_TOKEN;
  let pollMs = envPositiveInteger(env, ["POLL_MS", "CHATVIEW_POLL_MS"], 2000);
  let readChunkBytes = envPositiveInteger(env, ["READ_CHUNK_BYTES", "CHATVIEW_READ_CHUNK_BYTES"], 0) || undefined;
  let appendPath = envValue(env, "APPEND_PATH", "AGENT_APPEND_PATH", "CHATVIEW_AGENT_APPEND_PATH") ?? DEFAULT_APPEND_PATH;
  let logIdleEveryScans = envNonNegativeInteger(env, ["LOG_IDLE_EVERY_SCANS", "CHATVIEW_LOG_IDLE_EVERY_SCANS"], 30);
  let fetchPolicy = true;
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--root") {
      const parsed = parseRootSpec(argv[++i]);
      if (parsed) roots.push(parsed);
    } else if (value.startsWith("--root=")) {
      const parsed = parseRootSpec(value.slice("--root=".length));
      if (parsed) roots.push(parsed);
    } else if (value === "--projects-dir") {
      const rootPath = argv[++i];
      if (rootPath) roots.push({ provider: "claude", rootPath });
    } else if (value === "--state") {
      statePath = argv[++i] ?? statePath;
    } else if (value === "--backend") {
      backendUrl = argv[++i] ?? backendUrl;
    } else if (value === "--token") {
      token = argv[++i] ?? token;
    } else if (value === "--poll-ms") {
      pollMs = positiveInteger(argv[++i], pollMs) ?? pollMs;
    } else if (value === "--read-chunk-bytes") {
      readChunkBytes = positiveInteger(argv[++i], readChunkBytes);
    } else if (value === "--append-path") {
      appendPath = argv[++i] ?? appendPath;
    } else if (value === "--log-idle-every-scans") {
      logIdleEveryScans = nonNegativeInteger(argv[++i], logIdleEveryScans) ?? logIdleEveryScans;
    } else if (value === "--no-fetch-policy") {
      fetchPolicy = false;
    } else if (value === "--once") {
      once = true;
    }
  }

  return {
    roots: roots.length ? roots : rootsFromEnv(env),
    statePath,
    backendUrl: trimSlash(backendUrl),
    token,
    pollMs,
    readChunkBytes,
    appendPath,
    logIdleEveryScans,
    fetchPolicy,
    once,
    env,
  };
}

async function fetchWithRetry(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  const maxAttempts = 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok) return response;
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        await response.body?.cancel().catch(() => {});
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt === maxAttempts - 1) break;
    const base = Math.min(8000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function emptySummary(agentId: string, policy: SyncPolicy, roots: SyncRootConfig[]): AgentV2ScanSummary {
  return {
    agentId,
    policySource: policy.source,
    uploadsEnabled: policy.uploadsEnabled,
    roots,
    fileCount: 0,
    pendingRecordCount: 0,
    plannedChunkCount: 0,
    uploadedChunkCount: 0,
    skippedCount: 0,
  };
}

function countPendingRecords(batches: TailBatch[]) {
  return batches.reduce((sum, batch) => sum + batch.records.length, 0);
}

function formatAgentV2Summary(summary: AgentV2ScanSummary, mode: "activity" | "idle") {
  const uploadNote = summary.uploadsEnabled ? `uploaded ${summary.uploadedChunkCount}` : "uploads disabled";
  return [
    `[agent-v2] ${mode}`,
    `files ${summary.fileCount}`,
    `pending ${summary.pendingRecordCount}`,
    `planned ${summary.plannedChunkCount}`,
    uploadNote,
    `policy ${summary.policySource}`,
  ].join("; ");
}

function normalizePath(value: string) {
  return value.startsWith("/") ? value : `/${value}`;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number | undefined) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envNonNegativeInteger(env: EnvSource, names: string[], fallback: number) {
  for (const name of names) {
    const parsed = nonNegativeInteger(envValue(env, name), undefined);
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number | undefined) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
