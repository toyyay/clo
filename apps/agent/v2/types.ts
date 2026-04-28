export const AGENT_V2_VERSION = "0.1.0-v2";

export type ProviderKind = "claude" | "codex" | "gemini";

export type AgentV2Identity = {
  agentId: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  runtimeId: string;
  pid: number;
  startedAt: string;
};

export type AgentV2State = {
  agentId: string;
  cursors: Record<string, AppendJsonlCursor>;
  previewCursors?: Record<string, AppendJsonlCursor>;
};

export type AppendJsonlCursor = {
  generation: number;
  offset: number;
  lineNo: number;
  sizeBytes: number;
  mtimeMs: number;
  tailSha256?: string;
  dev?: number;
  ino?: number;
};

export type SyncRootConfig = {
  provider: ProviderKind;
  rootPath: string;
  ignorePatterns?: string[];
};

export type InventoryRootScan = {
  provider: ProviderKind;
  rootPath: string;
  authoritative: boolean;
  reason?: "ok" | "missing" | "not_directory" | "read_error";
};

export type InventoryScanResult = {
  files: InventoryFile[];
  roots: InventoryRootScan[];
};

export type InventoryFile = {
  provider: ProviderKind;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
  logicalId: string;
  sessionId?: string;
  projectKey?: string;
};

export type SyncPolicy = {
  enabled: boolean;
  uploadsEnabled: boolean;
  maxFileBytes: number;
  maxUploadChunkBytes: number;
  maxUploadLines: number;
  scanRoots: ProviderKind[];
  ignorePatterns: string[];
  source: "server" | "default";
};

export type TailRecord = {
  lineNo: number;
  offset: number;
  byteLength: number;
  rawLine: string;
};

export type TailBatch = {
  file: InventoryFile;
  records: TailRecord[];
  rawStartOffset: number;
  rawBytes: Uint8Array;
  nextCursor: AppendJsonlCursor;
  truncated: boolean;
  reset: boolean;
};

export type UploadChunk = {
  chunkId: string;
  generation: number;
  provider: ProviderKind;
  sourcePath: string;
  relativePath: string;
  logicalId: string;
  sessionId?: string;
  projectKey?: string;
  sizeBytes: number;
  mtimeMs: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  byteLength: number;
  rawText: string;
  omitRawText?: boolean;
  rawSha256?: string;
  rawBytes?: number;
  records: TailRecord[];
  diagnostics?: UploadDiagnosticEvent[];
};

export type UploadDiagnosticEvent = {
  reason: "record_too_large";
  message: string;
  lineNo: number;
  offset: number;
  byteLength: number;
  maxBytes: number;
  rawSha256: string;
};

export type UploadPlan = {
  chunks: UploadChunk[];
  skipped: Array<{ sourcePath: string; reason: string }>;
};

export type UploadTransport = {
  uploadChunk(chunk: UploadChunk): Promise<void>;
};
