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
  sourceProvider?: string | null;
  sourceKind?: string | null;
  sourceGeneration?: number | null;
  sourceId?: string | null;
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
  metadataCursor?: string;
  metadataMode?: "full" | "delta";
  metadataLimit?: number;
  limitBytes?: number;
  metadataOnly?: boolean;
};

export type SyncResponse = {
  cursor: string;
  hasMore: boolean;
  approxBytes: number;
  metadataCursor?: string;
  metadataHasMore?: boolean;
  metadataMode?: "full" | "delta";
  metadataFull?: boolean;
  hosts: HostInfo[];
  sessions: SessionInfo[];
  events: SessionEvent[];
};

export type AppLogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type AppLogSource = "frontend" | "backend";

export type AppLogInput = {
  id?: string;
  source?: AppLogSource;
  level: AppLogLevel;
  event: string;
  message?: string | null;
  tags?: string[];
  context?: unknown;
  client?: unknown;
  createdAt?: string;
};

export type AppLogBatchRequest = {
  logs: AppLogInput[];
};

export type AppLogBatchResponse = {
  ok: true;
  accepted: number;
};

export type AppLogInfo = {
  id: string;
  source: AppLogSource;
  level: AppLogLevel;
  event: string;
  message?: string | null;
  tags: string[];
  context: unknown;
  client: unknown;
  request: unknown;
  url?: string | null;
  userAgent?: string | null;
  clientLogId?: string | null;
  clientCreatedAt?: string | null;
  createdAt: string;
};

export type AppLogListResponse = {
  logs: AppLogInfo[];
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

export type ImportTokenInfo = {
  id: string;
  label: string;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt?: string | null;
  uploadUrl: string;
  shortcutUrl: string;
};

export type AppSettingsInfo = {
  origin: string;
  importUploadPath: string;
  shortcutUploadPath: string;
  importTokens: ImportTokenInfo[];
  openRouter: OpenRouterStatusInfo;
  transcriptionModels: OpenRouterModelOption[];
  reasoningEfforts: OpenRouterReasoningEffort[];
};

export type OpenRouterModelOption = {
  id: string;
  label: string;
  description: string;
};

export const OPENROUTER_TRANSCRIPTION_MODELS = [
  {
    id: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    description: "Best quality",
  },
  {
    id: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    description: "Fast default",
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    description: "Cheaper retry",
  },
] as const satisfies OpenRouterModelOption[];

export const OPENROUTER_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];

export type OpenRouterStatusInfo = {
  configured: boolean;
  status: "missing" | "checking" | "ok" | "error";
  model: string;
  reasoningEffort: string;
  endpoint: string;
  keyEndpoint: string;
  checkedAt?: string | null;
  message?: string | null;
  key?: {
    label?: string | null;
    limit?: number | null;
    usage?: number | null;
    limitRemaining?: number | null;
    isFreeTier?: boolean | null;
    rateLimit?: {
      requests?: number | null;
      interval?: string | null;
    } | null;
  } | null;
};

export type AudioTranscriptLevel = {
  literal: string;
  clean: string;
  summary: string;
  brief: string;
};

export type AudioTranscriptPayload = {
  detectedLanguage?: string | null;
  detectedLanguageName?: string | null;
  ru: AudioTranscriptLevel;
  en: AudioTranscriptLevel;
};

export type AudioTranscriptionInfo = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  source: string;
  model: string;
  reasoningEffort: string;
  transcript?: AudioTranscriptPayload | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type ImportedAudioInfo = {
  id: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string | null;
  filename?: string | null;
  detectedFormat?: string | null;
  createdAt: string;
  lastSeenAt: string;
  durationSeconds?: number | null;
  transcriptions: AudioTranscriptionInfo[];
};
