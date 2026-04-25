export const AGENT_V2_VERSION = "0.1.0-v2";

export type ProviderKind = "claude" | "codex" | "gemini";

export type AgentV2Identity = {
  agentId: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
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
  nextCursor: AppendJsonlCursor;
  truncated: boolean;
  reset: boolean;
};

export type UploadChunk = {
  chunkId: string;
  provider: ProviderKind;
  sourcePath: string;
  relativePath: string;
  logicalId: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  byteLength: number;
  records: TailRecord[];
};

export type UploadPlan = {
  chunks: UploadChunk[];
  skipped: Array<{ sourcePath: string; reason: string }>;
};

export type UploadTransport = {
  uploadChunk(chunk: UploadChunk): Promise<void>;
};
