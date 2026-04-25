import { homedir } from "node:os";
import { join } from "node:path";
import { readAppendJsonl } from "./cursor";
import { defaultSyncRoots, scanInventory } from "./inventory";
import { DEFAULT_SYNC_POLICY, fetchServerSyncPolicy } from "./policy";
import { planUploadChunks } from "./planner";
import { parseRootSpec } from "./roots";
import { identityForAgentV2, loadAgentV2State, saveAgentV2State } from "./state";
import type { ProviderKind, SyncRootConfig, TailBatch } from "./types";

export type AgentV2DryRunOptions = {
  roots?: SyncRootConfig[];
  statePath: string;
  backendUrl?: string;
  token?: string;
  readChunkBytes?: number;
  fetchPolicy?: boolean;
  persistState?: boolean;
};

export type AgentV2DryRunSummary = {
  agentId: string;
  policySource: "server" | "default";
  roots: SyncRootConfig[];
  fileCount: number;
  pendingRecordCount: number;
  plannedChunkCount: number;
  skippedCount: number;
  files: Array<{
    provider: ProviderKind;
    sourcePath: string;
    relativePath: string;
    sizeBytes: number;
    pendingRecords: number;
  }>;
};

export async function runAgentV2DryRun(options: AgentV2DryRunOptions): Promise<AgentV2DryRunSummary> {
  const state = await loadAgentV2State(options.statePath);
  const identity = identityForAgentV2(state);
  const roots = options.roots ?? defaultSyncRoots();
  const shouldFetchPolicy = options.fetchPolicy === true && !!options.backendUrl;
  const policy = shouldFetchPolicy
    ? await fetchServerSyncPolicy({
        backendUrl: options.backendUrl!,
        token: options.token,
        identity,
      })
    : DEFAULT_SYNC_POLICY;

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
  if (options.persistState) {
    state.previewCursors = {
      ...(state.previewCursors ?? {}),
      ...Object.fromEntries(batches.map((batch) => [batch.file.sourcePath, batch.nextCursor])),
    };
    await saveAgentV2State(options.statePath, state);
  }

  return {
    agentId: state.agentId,
    policySource: policy.source,
    roots,
    fileCount: files.length,
    pendingRecordCount: batches.reduce((sum, batch) => sum + batch.records.length, 0),
    plannedChunkCount: plan.chunks.length,
    skippedCount: plan.skipped.length,
    files: files.map((file) => ({
      provider: file.provider,
      sourcePath: file.sourcePath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      pendingRecords: batches.find((batch) => batch.file.sourcePath === file.sourcePath)?.records.length ?? 0,
    })),
  };
}

export async function runAgentV2DryRunFromCli(argv: string[]) {
  const options = parseDryRunArgs(argv);
  const summary = await runAgentV2DryRun(options);
  console.log(JSON.stringify(summary, null, 2));
}

function parseDryRunArgs(argv: string[]): AgentV2DryRunOptions {
  const roots: SyncRootConfig[] = [];
  let statePath = join(homedir(), ".chatview-agent", "v2-state.json");
  let backendUrl: string | undefined;
  let token: string | undefined;
  let readChunkBytes: number | undefined;
  let fetchPolicy = false;
  let persistState = false;

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--root") {
      const parsed = parseRootSpec(argv[++i]);
      if (parsed) roots.push(parsed);
    } else if (value === "--state") {
      statePath = argv[++i] ?? statePath;
    } else if (value === "--backend") {
      backendUrl = argv[++i];
    } else if (value === "--token") {
      token = argv[++i];
    } else if (value === "--read-chunk-bytes") {
      readChunkBytes = positiveInteger(argv[++i]);
    } else if (value === "--fetch-policy") {
      fetchPolicy = true;
    } else if (value === "--persist-state") {
      persistState = true;
    }
  }

  return {
    roots: roots.length ? roots : undefined,
    statePath,
    backendUrl,
    token,
    readChunkBytes,
    fetchPolicy,
    persistState,
  };
}

function positiveInteger(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
