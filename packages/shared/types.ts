export type AgentIdentity = {
  agentId: string;
  hostname: string;
  platform: string;
  arch: string;
  version: string;
  sourceRoot: string;
};

export type IngestEvent = {
  lineNo: number;
  offset: number;
  raw: unknown;
  eventType?: string;
  role?: string;
  createdAt?: string;
  title?: string;
  lineSha256?: string;
};

export type FileMetadata = {
  contentSha256?: string;
  mimeType?: string;
  encoding?: string;
  lineCount?: number;
  mode?: number;
  symlinkTarget?: string;
};

export type GitMetadata = {
  repoRoot?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  remoteUrl?: string;
};

export type IngestSession = {
  projectKey: string;
  projectName?: string;
  sessionId: string;
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  events: IngestEvent[];
  file?: FileMetadata;
  git?: GitMetadata;
  deleted?: boolean;
};

export type IngestBatchRequest = {
  agent: AgentIdentity;
  sessions: IngestSession[];
};

export type IngestBatchResponse = {
  ok: true;
  acceptedEvents: number;
  sessions: number;
};

export type HostInfo = {
  agentId: string;
  hostname: string;
  platform?: string;
  arch?: string;
  version?: string;
  sourceRoot?: string;
  lastSeenAt: string;
  createdAt: string;
  sessionCount: number;
  eventCount: number;
};

export type SessionInfo = {
  id: string;
  agentId: string;
  hostname: string;
  projectKey: string;
  projectName: string;
  sessionId: string;
  title?: string | null;
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
  contentSha256?: string | null;
  mimeType?: string | null;
  encoding?: string | null;
  lineCount?: number | null;
  mode?: number | null;
  symlinkTarget?: string | null;
  gitRepoRoot?: string | null;
  gitBranch?: string | null;
  gitCommit?: string | null;
  gitDirty?: boolean | null;
  gitRemoteUrl?: string | null;
  deletedAt?: string | null;
};

export type SessionEvent = {
  id: string;
  sessionDbId: string;
  lineNo: number;
  offset: number;
  eventType?: string | null;
  role?: string | null;
  createdAt?: string | null;
  ingestedAt: string;
  raw: unknown;
};

export type SessionPayload = {
  session: SessionInfo;
  events: SessionEvent[];
};

export type SyncRequest = {
  cursor?: string;
  limitBytes?: number;
};

export type SyncResponse = {
  cursor: string;
  hasMore: boolean;
  approxBytes: number;
  hosts: HostInfo[];
  sessions: SessionInfo[];
  events: SessionEvent[];
};

export type StreamMessage = {
  type: "ingest";
  agentId: string;
  sessionIds: string[];
  acceptedEvents: number;
};

export type YjsSyncDocRequest = {
  docId: string;
  sessionDbId?: string;
  stateVector?: string;
  update?: string;
};

export type YjsSyncRequest = {
  docs: YjsSyncDocRequest[];
};

export type YjsSyncDocResponse = {
  docId: string;
  update?: string;
  updatedAt?: string;
};

export type YjsSyncResponse = {
  docs: YjsSyncDocResponse[];
};

export type YjsSocketMessage =
  | { type: "subscribe"; docIds: string[] }
  | { type: "update"; docId: string; sessionDbId?: string; update: string };
