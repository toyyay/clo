export const CHAT_SYNC_PROTOCOL = "agent-v1";
export const CHAT_SYNC_CONTRACT_VERSION = 1;

export const AGENT_V1_ENDPOINTS = {
  hello: "/api/agent/v1/hello",
  inventory: "/api/agent/v1/inventory",
  append: "/api/agent/v1/append",
} as const;

export const CHAT_PROVIDERS = ["claude", "codex", "gemini", "path", "unknown"] as const;
export type AgentProvider = (typeof CHAT_PROVIDERS)[number] | (string & {});
export type ChatProvider = AgentProvider;

export const WATCH_RULE_KINDS = ["append_jsonl", "append_log", "snapshot_file", "sqlite_reader", "ignore"] as const;
export type WatchRuleKind = (typeof WATCH_RULE_KINDS)[number];

export const NORMALIZED_EVENT_KINDS = [
  "message",
  "thinking",
  "tool_call",
  "tool_result",
  "session",
  "turn",
  "meta",
  "event",
  "system",
  "metadata",
  "error",
  "unknown",
] as const;
export type NormalizedEventKind = (typeof NORMALIZED_EVENT_KINDS)[number];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type AgentCursorMetadata = Record<string, unknown> & {
  generation?: number;
  sourceGeneration?: number;
  offset?: number;
  lineNo?: number;
  sizeBytes?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  tailSha256?: string;
  startOffset?: number;
  endOffset?: number;
  startLine?: number;
  endLine?: number;
  dev?: number | string;
  ino?: number | string;
  inode?: number | string;
};

export type AgentSyncCursor = {
  scope?: string;
  value?: string;
  metadata?: AgentCursorMetadata;
};

export type SyncCursor = {
  generation: number;
  offset: number;
  lineNo: number;
  sizeBytes?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  tailSha256?: string;
  dev?: number | string;
  ino?: number | string;
  inode?: number | string;
};

export type RedactionSummary = {
  applied: boolean;
  rules?: string[];
  counts?: Record<string, number>;
  note?: string;
};

export type SourceMetadata = {
  provider: AgentProvider;
  sourcePath?: string;
  fileId?: string;
  lineNo?: number;
  byteOffset?: number;
  rawType?: string;
  cursor?: SyncCursor;
  rawKind?: string;
  redaction?: RedactionSummary;
};

export type AgentDescriptor = {
  agentId: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  version?: string;
  sourceRoot?: string;
};

export type AgentCapabilities = {
  inventory?: boolean;
  appendJsonlCursors?: boolean;
  chunkedUploads?: boolean;
  providers?: AgentProvider[];
  [key: string]: unknown;
};

export type AgentHelloRequest = {
  agent: AgentDescriptor;
  capabilities?: AgentCapabilities;
};

export type AgentHelloResponse = {
  ok: boolean;
  protocol: typeof CHAT_SYNC_PROTOCOL;
  serverTime: string;
  agentId: string;
  policy: ServerSyncPolicy;
};

export type WatchRuleBase = {
  id: string;
  kind: WatchRuleKind;
  enabled?: boolean;
  provider?: AgentProvider;
  path: string;
  fileIdPrefix?: string;
  maxBytes?: number;
  maxRecords?: number;
};

export type AppendJsonlWatchRule = WatchRuleBase & {
  kind: "append_jsonl";
  lineFormat?: "json" | "jsonl";
};

export type AppendLogWatchRule = WatchRuleBase & {
  kind: "append_log";
  encoding?: "utf8";
};

export type SnapshotFileWatchRule = WatchRuleBase & {
  kind: "snapshot_file";
  contentKind?: "json" | "text" | "binary";
};

export type SqliteReaderWatchRule = WatchRuleBase & {
  kind: "sqlite_reader";
  query: string;
  cursorColumn?: string;
};

export type IgnoreWatchRule = WatchRuleBase & {
  kind: "ignore";
  reason?: string;
};

export type WatchRule =
  | AppendJsonlWatchRule
  | AppendLogWatchRule
  | SnapshotFileWatchRule
  | SqliteReaderWatchRule
  | IgnoreWatchRule;

export type AgentV1RequestLimits = {
  helloBytes: number;
  inventoryBytes: number;
  appendBytes: number;
  filesPerInventory: number;
  chunksPerAppend: number;
  eventsPerAppend: number;
  rawChunkBytes: number;
  metadataBytes: number;
  normalizedEventBytes: number;
};

export type AgentV1StoragePolicy = {
  rawChunks: "hash_only" | string;
  rawFilesStoredByDefault: boolean;
};

export type AgentV1CursorPolicy = {
  defaultScope: string;
};

export type ServerSyncPolicy = {
  protocol: typeof CHAT_SYNC_PROTOCOL;
  enabled: boolean;
  uploadsEnabled: boolean;
  maxFileBytes: number;
  maxUploadLines: number;
  maxUploadChunkBytes: number;
  scanRoots: readonly AgentProvider[];
  ignorePatterns: readonly string[];
  requestLimits: AgentV1RequestLimits;
  storage: AgentV1StoragePolicy;
  providers: readonly AgentProvider[];
  cursors: AgentV1CursorPolicy;
  watchRules: readonly WatchRule[];
  serverGeneratedAt: string;
};

export type ServerSyncConfig = {
  protocol: typeof CHAT_SYNC_PROTOCOL;
  generatedAt: string;
  policy: ServerSyncPolicy;
  endpoints?: Partial<typeof AGENT_V1_ENDPOINTS>;
};

export type AgentSourceFile = {
  provider: AgentProvider;
  sourcePath?: string;
  path?: string;
  relativePath?: string;
  logicalId?: string;
  fileId?: string;
  sourceKind?: string;
  kind?: string;
  generation?: number;
  sourceGeneration?: number;
  fileGeneration?: number;
  pathSha256?: string;
  sizeBytes?: number;
  mtimeMs?: number | null;
  contentSha256?: string;
  mimeType?: string;
  encoding?: string;
  lineCount?: number;
  git?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  redaction?: Record<string, unknown>;
  deleted?: boolean;
};

export type AgentInventoryRequest = {
  agent: AgentDescriptor;
  files: AgentSourceFile[];
  cursor?: AgentSyncCursor;
};

export type AgentInventoryResponse = {
  ok: boolean;
  acceptedFiles: number;
  deletedFiles: number;
  fileIds: string[];
  policy: ServerSyncPolicy;
};

export type AgentNormalizedEventInput = {
  eventUid?: string;
  id?: string;
  eventType?: string;
  kind?: string;
  type?: string;
  role?: string;
  occurredAt?: string;
  createdAt?: string;
  sourceOffset?: number;
  offset?: number;
  sourceLineNo?: number;
  lineNo?: number;
  contentSha256?: string;
  sha256?: string;
  metadata?: Record<string, unknown>;
  redaction?: Record<string, unknown>;
  normalized?: Record<string, unknown>;
  source?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AgentAppendChunk = {
  chunkId: string;
  generation?: number;
  sourceGeneration?: number;
  fileGeneration?: number;
  sequence?: number;
  cursorStart?: string;
  cursorEnd?: string;
  rawSha256?: string;
  rawBytes: number;
  rawText?: string;
  rawBase64?: string;
  compression?: string;
  encoding?: "utf8" | string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  redaction?: Record<string, unknown>;
  events: AgentNormalizedEventInput[];
};

export type AgentAppendRequest = {
  agent: AgentDescriptor;
  files?: AgentSourceFile[];
  source: AgentSourceFile;
  cursor?: AgentSyncCursor;
  chunks: AgentAppendChunk[];
};

export type AgentAppendResponse = {
  ok: boolean;
  sourceFileId: string;
  acceptedChunks: number;
  acceptedEvents: number;
  cursor: string;
  storage: AgentV1StoragePolicy;
};

export type InventoryReport = AgentInventoryRequest;
export type AppendChunkUpload = AgentAppendRequest;
export type AppendChunkAck = AgentAppendResponse;

export type NormalizedChat = {
  id: string;
  provider: AgentProvider;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  source: SourceMetadata;
  sessions?: NormalizedSession[];
};

export type NormalizedSession = {
  id: string;
  chatId?: string;
  provider: AgentProvider;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  source: SourceMetadata;
  events?: NormalizedEvent[];
};

export type NormalizedEvent = {
  id: string;
  sessionId?: string;
  parentId?: string;
  provider: AgentProvider;
  kind: NormalizedEventKind;
  role?: "user" | "assistant" | "system" | "tool" | "unknown";
  text?: string;
  payload?: unknown;
  createdAt?: string;
  source: SourceMetadata;
};

type RecordValue = Record<string, unknown>;

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(path: string, message: string): ValidationResult<T> {
  return { ok: false, error: `${path}: ${message}` };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function validateString(value: unknown, path: string): ValidationResult<string> {
  return isString(value) ? ok(value) : fail(path, "expected non-empty string");
}

function validateOptionalString(value: unknown, path: string): ValidationResult<string | undefined> {
  return value === undefined ? ok(undefined) : validateString(value, path);
}

function validateOptionalRecord(value: unknown, path: string): ValidationResult<Record<string, unknown> | undefined> {
  if (value === undefined) return ok(undefined);
  return isRecord(value) ? ok(value) : fail(path, "expected object");
}

function validateStringArray(value: unknown, path: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return fail(path, "expected array");
  for (let index = 0; index < value.length; index += 1) {
    if (!isString(value[index])) return fail(`${path}[${index}]`, "expected non-empty string");
  }
  return ok(value);
}

function validateProvider(value: unknown, path: string): ValidationResult<AgentProvider> {
  if (!isString(value)) return fail(path, "expected non-empty string");
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(value)) return fail(path, "expected provider identifier");
  return ok(value as AgentProvider);
}

function validateProviderArray(value: unknown, path: string): ValidationResult<AgentProvider[]> {
  if (!Array.isArray(value)) return fail(path, "expected array");
  for (let index = 0; index < value.length; index += 1) {
    const provider = validateProvider(value[index], `${path}[${index}]`);
    if (!provider.ok) return provider;
  }
  return ok(value as AgentProvider[]);
}

function validateOptionalPositiveInteger(value: unknown, path: string): ValidationResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return isPositiveInteger(value) ? ok(value) : fail(path, "expected positive integer");
}

function validateOptionalNonNegativeInteger(value: unknown, path: string): ValidationResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return isNonNegativeInteger(value) ? ok(value) : fail(path, "expected non-negative integer");
}

function validateOptionalNonNegativeNumber(value: unknown, path: string): ValidationResult<number | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  return isFiniteNumber(value) && value >= 0 ? ok(value) : fail(path, "expected non-negative number");
}

function validateOptionalBoolean(value: unknown, path: string): ValidationResult<boolean | undefined> {
  if (value === undefined) return ok(undefined);
  return typeof value === "boolean" ? ok(value) : fail(path, "expected boolean");
}

function validateOptionalIsoString(value: unknown, path: string): ValidationResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isString(value)) return fail(path, "expected non-empty string");
  if (Number.isNaN(Date.parse(value))) return fail(path, "expected parseable date-time string");
  return ok(value);
}

function validateOptionalSha256(value: unknown, path: string): ValidationResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isString(value)) return fail(path, "expected non-empty string");
  if (!/^[a-f0-9]{64}$/i.test(value)) return fail(path, "expected sha256 hex string");
  return ok(value);
}

function validateStringOrNumber(value: unknown, path: string): ValidationResult<string | number | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value === "string" || isFiniteNumber(value)) return ok(value);
  return fail(path, "expected string or number");
}

function validateCursorMetadata(input: unknown, path: string): ValidationResult<AgentCursorMetadata | undefined> {
  if (input === undefined) return ok(undefined);
  if (!isRecord(input)) return fail(path, "expected object");

  for (const field of ["generation", "sourceGeneration"] as const) {
    if (input[field] !== undefined && !isPositiveInteger(input[field])) {
      return fail(`${path}.${field}`, "expected positive integer");
    }
  }

  for (const field of ["offset", "lineNo", "sizeBytes", "startOffset", "endOffset", "startLine", "endLine"] as const) {
    if (input[field] !== undefined && !isNonNegativeInteger(input[field])) {
      return fail(`${path}.${field}`, "expected non-negative integer");
    }
  }

  for (const field of ["mtimeMs", "ctimeMs"] as const) {
    if (input[field] !== undefined && (!isFiniteNumber(input[field]) || input[field] < 0)) {
      return fail(`${path}.${field}`, "expected non-negative number");
    }
  }

  const tailSha256 = validateOptionalSha256(input.tailSha256, `${path}.tailSha256`);
  if (!tailSha256.ok) return tailSha256;

  for (const field of ["dev", "ino", "inode"] as const) {
    const result = validateStringOrNumber(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }

  return ok(input as AgentCursorMetadata);
}

function validateMetadataGeneration(input: unknown, path: string): ValidationResult<undefined> {
  if (!isRecord(input) || input.generation === undefined) return ok(undefined);
  return isNonNegativeInteger(input.generation) ? ok(undefined) : fail(`${path}.generation`, "expected non-negative integer");
}

function validateAgentSyncCursorAt(input: unknown, path: string): ValidationResult<AgentSyncCursor> {
  if (!isRecord(input)) return fail(path, "expected object");
  const scope = validateOptionalString(input.scope, `${path}.scope`);
  if (!scope.ok) return scope;
  const value = validateOptionalString(input.value, `${path}.value`);
  if (!value.ok) return value;
  const metadata = validateCursorMetadata(input.metadata, `${path}.metadata`);
  if (!metadata.ok) return metadata;
  return ok(input as AgentSyncCursor);
}

export function validateAgentSyncCursor(input: unknown): ValidationResult<AgentSyncCursor> {
  return validateAgentSyncCursorAt(input, "cursor");
}

export function validateSyncCursor(input: unknown): ValidationResult<SyncCursor> {
  if (!isRecord(input)) return fail("cursor", "expected object");
  for (const field of ["generation", "offset", "lineNo"] as const) {
    if (!isNonNegativeInteger(input[field])) return fail(`cursor.${field}`, "expected non-negative integer");
  }
  for (const field of ["sizeBytes", "mtimeMs", "ctimeMs"] as const) {
    const result =
      field === "sizeBytes"
        ? validateOptionalNonNegativeInteger(input[field], `cursor.${field}`)
        : validateOptionalNonNegativeNumber(input[field], `cursor.${field}`);
    if (!result.ok) return result;
  }
  const tailSha256 = validateOptionalSha256(input.tailSha256, "cursor.tailSha256");
  if (!tailSha256.ok) return tailSha256;
  for (const field of ["dev", "ino", "inode"] as const) {
    const result = validateStringOrNumber(input[field], `cursor.${field}`);
    if (!result.ok) return result;
  }
  return ok(input as SyncCursor);
}

export function validateRedactionSummary(input: unknown): ValidationResult<RedactionSummary> {
  if (!isRecord(input)) return fail("redaction", "expected object");
  if (typeof input.applied !== "boolean") return fail("redaction.applied", "expected boolean");
  if (input.rules !== undefined) {
    const rules = validateStringArray(input.rules, "redaction.rules");
    if (!rules.ok) return rules;
  }
  if (input.counts !== undefined) {
    if (!isRecord(input.counts)) return fail("redaction.counts", "expected object");
    for (const [key, value] of Object.entries(input.counts)) {
      if (!isNonNegativeInteger(value)) return fail(`redaction.counts.${key}`, "expected non-negative integer");
    }
  }
  const note = validateOptionalString(input.note, "redaction.note");
  if (!note.ok) return note;
  return ok(input as RedactionSummary);
}

export function validateSourceMetadata(input: unknown): ValidationResult<SourceMetadata> {
  if (!isRecord(input)) return fail("source", "expected object");
  const provider = validateProvider(input.provider, "source.provider");
  if (!provider.ok) return provider;
  const sourcePath = validateOptionalString(input.sourcePath, "source.sourcePath");
  if (!sourcePath.ok) return sourcePath;
  const fileId = validateOptionalString(input.fileId, "source.fileId");
  if (!fileId.ok) return fileId;
  for (const field of ["lineNo", "byteOffset"] as const) {
    if (input[field] !== undefined && !isNonNegativeInteger(input[field])) {
      return fail(`source.${field}`, "expected non-negative integer");
    }
  }
  const rawType = validateOptionalString(input.rawType, "source.rawType");
  if (!rawType.ok) return rawType;
  if (input.cursor !== undefined) {
    const cursor = validateSyncCursor(input.cursor);
    if (!cursor.ok) return { ok: false, error: cursor.error.replace(/^cursor/, "source.cursor") };
  }
  const rawKind = validateOptionalString(input.rawKind, "source.rawKind");
  if (!rawKind.ok) return rawKind;
  if (input.redaction !== undefined) {
    const redaction = validateRedactionSummary(input.redaction);
    if (!redaction.ok) return { ok: false, error: redaction.error.replace(/^redaction/, "source.redaction") };
  }
  return ok(input as SourceMetadata);
}

export function validateAgentDescriptor(input: unknown): ValidationResult<AgentDescriptor> {
  if (!isRecord(input)) return fail("agent", "expected object");
  const agentId = validateString(input.agentId, "agent.agentId");
  if (!agentId.ok) return agentId;
  for (const field of ["hostname", "platform", "arch", "version", "sourceRoot"] as const) {
    const result = validateOptionalString(input[field], `agent.${field}`);
    if (!result.ok) return result;
  }
  return ok(input as AgentDescriptor);
}

export function validateAgentCapabilities(input: unknown): ValidationResult<AgentCapabilities> {
  if (!isRecord(input)) return fail("capabilities", "expected object");
  for (const field of ["inventory", "appendJsonlCursors", "chunkedUploads"] as const) {
    const result = validateOptionalBoolean(input[field], `capabilities.${field}`);
    if (!result.ok) return result;
  }
  if (input.providers !== undefined) {
    const providers = validateProviderArray(input.providers, "capabilities.providers");
    if (!providers.ok) return providers;
  }
  return ok(input as AgentCapabilities);
}

export function validateAgentHelloRequest(input: unknown): ValidationResult<AgentHelloRequest> {
  if (!isRecord(input)) return fail("hello", "expected object");
  const agent = validateAgentDescriptor(input.agent);
  if (!agent.ok) return agent;
  if (input.capabilities !== undefined) {
    const capabilities = validateAgentCapabilities(input.capabilities);
    if (!capabilities.ok) return capabilities;
  }
  return ok(input as AgentHelloRequest);
}

export function validateWatchRule(input: unknown): ValidationResult<WatchRule> {
  if (!isRecord(input)) return fail("watchRule", "expected object");
  const id = validateString(input.id, "watchRule.id");
  if (!id.ok) return id;
  if (!oneOf(input.kind, WATCH_RULE_KINDS)) return fail("watchRule.kind", "expected supported watch rule kind");
  const path = validateString(input.path, "watchRule.path");
  if (!path.ok) return path;
  const enabled = validateOptionalBoolean(input.enabled, "watchRule.enabled");
  if (!enabled.ok) return enabled;
  if (input.provider !== undefined) {
    const provider = validateProvider(input.provider, "watchRule.provider");
    if (!provider.ok) return provider;
  }
  const fileIdPrefix = validateOptionalString(input.fileIdPrefix, "watchRule.fileIdPrefix");
  if (!fileIdPrefix.ok) return fileIdPrefix;
  for (const field of ["maxBytes", "maxRecords"] as const) {
    const result = validateOptionalPositiveInteger(input[field], `watchRule.${field}`);
    if (!result.ok) return result;
  }
  if (input.kind === "append_jsonl" && input.lineFormat !== undefined && input.lineFormat !== "json" && input.lineFormat !== "jsonl") {
    return fail("watchRule.lineFormat", "expected json or jsonl");
  }
  if (input.kind === "append_log" && input.encoding !== undefined && input.encoding !== "utf8") {
    return fail("watchRule.encoding", "expected utf8");
  }
  if (
    input.kind === "snapshot_file" &&
    input.contentKind !== undefined &&
    input.contentKind !== "json" &&
    input.contentKind !== "text" &&
    input.contentKind !== "binary"
  ) {
    return fail("watchRule.contentKind", "expected json, text, or binary");
  }
  if (input.kind === "sqlite_reader") {
    const query = validateString(input.query, "watchRule.query");
    if (!query.ok) return query;
    const cursorColumn = validateOptionalString(input.cursorColumn, "watchRule.cursorColumn");
    if (!cursorColumn.ok) return cursorColumn;
  }
  if (input.kind === "ignore") {
    const reason = validateOptionalString(input.reason, "watchRule.reason");
    if (!reason.ok) return reason;
  }
  return ok(input as WatchRule);
}

function validateRequestLimits(input: unknown): ValidationResult<AgentV1RequestLimits> {
  if (!isRecord(input)) return fail("policy.requestLimits", "expected object");
  for (const field of [
    "helloBytes",
    "inventoryBytes",
    "appendBytes",
    "filesPerInventory",
    "chunksPerAppend",
    "eventsPerAppend",
    "rawChunkBytes",
    "metadataBytes",
    "normalizedEventBytes",
  ] as const) {
    if (!isPositiveInteger(input[field])) return fail(`policy.requestLimits.${field}`, "expected positive integer");
  }
  return ok(input as AgentV1RequestLimits);
}

function validateStoragePolicy(input: unknown): ValidationResult<AgentV1StoragePolicy> {
  if (!isRecord(input)) return fail("policy.storage", "expected object");
  const rawChunks = validateString(input.rawChunks, "policy.storage.rawChunks");
  if (!rawChunks.ok) return rawChunks;
  if (typeof input.rawFilesStoredByDefault !== "boolean") {
    return fail("policy.storage.rawFilesStoredByDefault", "expected boolean");
  }
  return ok(input as AgentV1StoragePolicy);
}

function validateCursorPolicy(input: unknown): ValidationResult<AgentV1CursorPolicy> {
  if (!isRecord(input)) return fail("policy.cursors", "expected object");
  const defaultScope = validateString(input.defaultScope, "policy.cursors.defaultScope");
  if (!defaultScope.ok) return defaultScope;
  return ok(input as AgentV1CursorPolicy);
}

export function validateServerSyncPolicy(input: unknown): ValidationResult<ServerSyncPolicy> {
  if (!isRecord(input)) return fail("policy", "expected object");
  if (input.protocol !== CHAT_SYNC_PROTOCOL) return fail("policy.protocol", `expected ${CHAT_SYNC_PROTOCOL}`);
  for (const field of ["maxFileBytes", "maxUploadLines", "maxUploadChunkBytes"] as const) {
    if (!isPositiveInteger(input[field])) return fail(`policy.${field}`, "expected positive integer");
  }
  for (const field of ["enabled", "uploadsEnabled"] as const) {
    if (typeof input[field] !== "boolean") return fail(`policy.${field}`, "expected boolean");
  }
  const scanRoots = validateProviderArray(input.scanRoots, "policy.scanRoots");
  if (!scanRoots.ok) return scanRoots;
  const ignorePatterns = validateStringArray(input.ignorePatterns, "policy.ignorePatterns");
  if (!ignorePatterns.ok) return ignorePatterns;
  const requestLimits = validateRequestLimits(input.requestLimits);
  if (!requestLimits.ok) return requestLimits;
  const storage = validateStoragePolicy(input.storage);
  if (!storage.ok) return storage;
  const providers = validateProviderArray(input.providers, "policy.providers");
  if (!providers.ok) return providers;
  const cursors = validateCursorPolicy(input.cursors);
  if (!cursors.ok) return cursors;
  if (!Array.isArray(input.watchRules)) return fail("policy.watchRules", "expected array");
  for (let index = 0; index < input.watchRules.length; index += 1) {
    const rule = validateWatchRule(input.watchRules[index]);
    if (!rule.ok) return { ok: false, error: rule.error.replace(/^watchRule/, `policy.watchRules[${index}]`) };
  }
  const generatedAt = validateOptionalIsoString(input.serverGeneratedAt, "policy.serverGeneratedAt");
  if (!generatedAt.ok || generatedAt.value === undefined) {
    return fail("policy.serverGeneratedAt", "expected parseable date-time string");
  }
  return ok(input as ServerSyncPolicy);
}

export function validateServerSyncConfig(input: unknown): ValidationResult<ServerSyncConfig> {
  if (!isRecord(input)) return fail("config", "expected object");
  if (input.protocol !== CHAT_SYNC_PROTOCOL) return fail("config.protocol", `expected ${CHAT_SYNC_PROTOCOL}`);
  const generatedAt = validateOptionalIsoString(input.generatedAt, "config.generatedAt");
  if (!generatedAt.ok || generatedAt.value === undefined) return fail("config.generatedAt", "expected parseable date-time string");
  const policy = validateServerSyncPolicy(input.policy);
  if (!policy.ok) return policy;
  if (input.endpoints !== undefined) {
    if (!isRecord(input.endpoints)) return fail("config.endpoints", "expected object");
    for (const field of ["hello", "inventory", "append"] as const) {
      const endpoint = validateOptionalString(input.endpoints[field], `config.endpoints.${field}`);
      if (!endpoint.ok) return endpoint;
    }
  }
  return ok(input as ServerSyncConfig);
}

export function validateAgentHelloResponse(input: unknown): ValidationResult<AgentHelloResponse> {
  if (!isRecord(input)) return fail("helloResponse", "expected object");
  if (input.ok !== true) return fail("helloResponse.ok", "expected true");
  if (input.protocol !== CHAT_SYNC_PROTOCOL) return fail("helloResponse.protocol", `expected ${CHAT_SYNC_PROTOCOL}`);
  const serverTime = validateOptionalIsoString(input.serverTime, "helloResponse.serverTime");
  if (!serverTime.ok || serverTime.value === undefined) return fail("helloResponse.serverTime", "expected parseable date-time string");
  const agentId = validateString(input.agentId, "helloResponse.agentId");
  if (!agentId.ok) return agentId;
  const policy = validateServerSyncPolicy(input.policy);
  if (!policy.ok) return policy;
  return ok(input as AgentHelloResponse);
}

function validateAgentSourceFileAt(
  input: unknown,
  path: string,
  options: { allowMissingSize?: boolean } = {},
): ValidationResult<AgentSourceFile> {
  if (!isRecord(input)) return fail(path, "expected object");
  const provider = validateProvider(input.provider, `${path}.provider`);
  if (!provider.ok) return provider;
  if (input.sourcePath === undefined && input.path === undefined) return fail(`${path}.sourcePath`, "expected non-empty string");
  for (const field of ["sourcePath", "path", "relativePath", "logicalId", "fileId", "sourceKind", "kind", "mimeType", "encoding"] as const) {
    const result = validateOptionalString(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["pathSha256", "contentSha256"] as const) {
    const result = validateOptionalSha256(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  if (!options.allowMissingSize || input.sizeBytes !== undefined) {
    if (!isNonNegativeInteger(input.sizeBytes)) return fail(`${path}.sizeBytes`, "expected non-negative integer");
  }
  const mtimeMs = validateOptionalNonNegativeNumber(input.mtimeMs, `${path}.mtimeMs`);
  if (!mtimeMs.ok) return mtimeMs;
  const lineCount = validateOptionalNonNegativeInteger(input.lineCount, `${path}.lineCount`);
  if (!lineCount.ok) return lineCount;
  for (const field of ["generation", "sourceGeneration", "fileGeneration"] as const) {
    const result = validateOptionalPositiveInteger(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["git", "metadata", "redaction"] as const) {
    const result = validateOptionalRecord(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  const generation = validateMetadataGeneration(input.metadata, `${path}.metadata`);
  if (!generation.ok) return generation;
  const deleted = validateOptionalBoolean(input.deleted, `${path}.deleted`);
  if (!deleted.ok) return deleted;
  return ok(input as AgentSourceFile);
}

export function validateAgentSourceFile(input: unknown): ValidationResult<AgentSourceFile> {
  return validateAgentSourceFileAt(input, "sourceFile");
}

export function validateInventoryFileReport(input: unknown): ValidationResult<AgentSourceFile> {
  return validateAgentSourceFileAt(input, "inventoryFile");
}

export function validateAgentInventoryRequest(input: unknown): ValidationResult<AgentInventoryRequest> {
  if (!isRecord(input)) return fail("inventory", "expected object");
  const agent = validateAgentDescriptor(input.agent);
  if (!agent.ok) return agent;
  if (!Array.isArray(input.files)) return fail("inventory.files", "expected array");
  for (let index = 0; index < input.files.length; index += 1) {
    const file = validateAgentSourceFileAt(input.files[index], `inventory.files[${index}]`);
    if (!file.ok) return file;
  }
  if (input.cursor !== undefined) {
    const cursor = validateAgentSyncCursorAt(input.cursor, "inventory.cursor");
    if (!cursor.ok) return cursor;
  }
  return ok(input as AgentInventoryRequest);
}

export function validateInventoryReport(input: unknown): ValidationResult<InventoryReport> {
  return validateAgentInventoryRequest(input);
}

export function validateAgentInventoryResponse(input: unknown): ValidationResult<AgentInventoryResponse> {
  if (!isRecord(input)) return fail("inventoryResponse", "expected object");
  if (input.ok !== true) return fail("inventoryResponse.ok", "expected true");
  for (const field of ["acceptedFiles", "deletedFiles"] as const) {
    if (!isNonNegativeInteger(input[field])) return fail(`inventoryResponse.${field}`, "expected non-negative integer");
  }
  const fileIds = validateStringArray(input.fileIds, "inventoryResponse.fileIds");
  if (!fileIds.ok) return fileIds;
  const policy = validateServerSyncPolicy(input.policy);
  if (!policy.ok) return policy;
  return ok(input as AgentInventoryResponse);
}

function validateAgentNormalizedEventInputAt(input: unknown, path: string): ValidationResult<AgentNormalizedEventInput> {
  if (!isRecord(input)) return fail(path, "expected object");
  for (const field of ["eventUid", "id", "eventType", "kind", "type", "role"] as const) {
    const result = validateOptionalString(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["occurredAt", "createdAt"] as const) {
    const result = validateOptionalIsoString(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["sourceOffset", "offset", "sourceLineNo", "lineNo"] as const) {
    const result = validateOptionalNonNegativeInteger(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["contentSha256", "sha256"] as const) {
    const result = validateOptionalSha256(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["metadata", "redaction", "normalized", "source"] as const) {
    const result = validateOptionalRecord(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  return ok(input as AgentNormalizedEventInput);
}

function isCursorPositionString(value: string) {
  const integer = "(?:0|[1-9][0-9]*)";
  return new RegExp(`^${integer}(?::${integer})?$`).test(value);
}

function validateCursorOffsetString(value: unknown, path: string): ValidationResult<string> {
  const text = validateString(value, path);
  if (!text.ok) return text;
  return isCursorPositionString(text.value) ? text : fail(path, "expected cursor offset string");
}

function validateAgentAppendChunkAt(input: unknown, path: string): ValidationResult<AgentAppendChunk> {
  if (!isRecord(input)) return fail(path, "expected object");
  const chunkId = validateString(input.chunkId, `${path}.chunkId`);
  if (!chunkId.ok) return chunkId;
  const sequence = validateOptionalNonNegativeInteger(input.sequence, `${path}.sequence`);
  if (!sequence.ok) return sequence;
  for (const field of ["generation", "sourceGeneration", "fileGeneration"] as const) {
    const result = validateOptionalPositiveInteger(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  if (input.cursorStart !== undefined) {
    const cursorStart = validateCursorOffsetString(input.cursorStart, `${path}.cursorStart`);
    if (!cursorStart.ok) return cursorStart;
  }
  if (input.cursorEnd !== undefined) {
    const cursorEnd = validateCursorOffsetString(input.cursorEnd, `${path}.cursorEnd`);
    if (!cursorEnd.ok) return cursorEnd;
  }
  const rawSha256 = validateOptionalSha256(input.rawSha256, `${path}.rawSha256`);
  if (!rawSha256.ok) return rawSha256;
  if (!isNonNegativeInteger(input.rawBytes)) return fail(`${path}.rawBytes`, "expected non-negative integer");
  for (const field of ["rawText", "rawBase64", "compression", "encoding", "contentType"] as const) {
    const result = validateOptionalString(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["metadata", "redaction"] as const) {
    const result = validateOptionalRecord(input[field], `${path}.${field}`);
    if (!result.ok) return result;
  }
  const generation = validateMetadataGeneration(input.metadata, `${path}.metadata`);
  if (!generation.ok) return generation;
  if (!Array.isArray(input.events)) return fail(`${path}.events`, "expected array");
  for (let index = 0; index < input.events.length; index += 1) {
    const event = validateAgentNormalizedEventInputAt(input.events[index], `${path}.events[${index}]`);
    if (!event.ok) return event;
  }
  return ok(input as AgentAppendChunk);
}

export function validateAgentAppendRequest(input: unknown): ValidationResult<AgentAppendRequest> {
  if (!isRecord(input)) return fail("append", "expected object");
  const agent = validateAgentDescriptor(input.agent);
  if (!agent.ok) return agent;
  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) return fail("append.files", "expected array");
    for (let index = 0; index < input.files.length; index += 1) {
      const file = validateAgentSourceFileAt(input.files[index], `append.files[${index}]`, { allowMissingSize: true });
      if (!file.ok) return file;
    }
  }
  const source = validateAgentSourceFileAt(input.source, "append.source", { allowMissingSize: true });
  if (!source.ok) return source;
  if (input.cursor !== undefined) {
    const cursor = validateAgentSyncCursorAt(input.cursor, "append.cursor");
    if (!cursor.ok) return cursor;
  }
  if (!Array.isArray(input.chunks)) return fail("append.chunks", "expected array");
  for (let index = 0; index < input.chunks.length; index += 1) {
    const chunk = validateAgentAppendChunkAt(input.chunks[index], `append.chunks[${index}]`);
    if (!chunk.ok) return chunk;
  }
  return ok(input as AgentAppendRequest);
}

export function validateAppendChunkUpload(input: unknown): ValidationResult<AppendChunkUpload> {
  return validateAgentAppendRequest(input);
}

export function validateAgentAppendResponse(input: unknown): ValidationResult<AgentAppendResponse> {
  if (!isRecord(input)) return fail("appendResponse", "expected object");
  if (input.ok !== true) return fail("appendResponse.ok", "expected true");
  const sourceFileId = validateString(input.sourceFileId, "appendResponse.sourceFileId");
  if (!sourceFileId.ok) return sourceFileId;
  for (const field of ["acceptedChunks", "acceptedEvents"] as const) {
    if (!isNonNegativeInteger(input[field])) return fail(`appendResponse.${field}`, "expected non-negative integer");
  }
  const cursor = validateString(input.cursor, "appendResponse.cursor");
  if (!cursor.ok) return cursor;
  const storage = validateStoragePolicyAt(input.storage, "appendResponse.storage");
  if (!storage.ok) return storage;
  return ok(input as AgentAppendResponse);
}

function validateStoragePolicyAt(input: unknown, path: string): ValidationResult<AgentV1StoragePolicy> {
  if (!isRecord(input)) return fail(path, "expected object");
  const rawChunks = validateString(input.rawChunks, `${path}.rawChunks`);
  if (!rawChunks.ok) return rawChunks;
  if (typeof input.rawFilesStoredByDefault !== "boolean") {
    return fail(`${path}.rawFilesStoredByDefault`, "expected boolean");
  }
  return ok(input as AgentV1StoragePolicy);
}

export function validateAppendChunkAck(input: unknown): ValidationResult<AppendChunkAck> {
  return validateAgentAppendResponse(input);
}

export function validateNormalizedChat(input: unknown): ValidationResult<NormalizedChat> {
  if (!isRecord(input)) return fail("chat", "expected object");
  const id = validateString(input.id, "chat.id");
  if (!id.ok) return id;
  const provider = validateProvider(input.provider, "chat.provider");
  if (!provider.ok) return provider;
  for (const field of ["title", "createdAt", "updatedAt"] as const) {
    const result = field === "title" ? validateOptionalString(input[field], `chat.${field}`) : validateOptionalIsoString(input[field], `chat.${field}`);
    if (!result.ok) return result;
  }
  const source = validateSourceMetadata(input.source);
  if (!source.ok) return { ok: false, error: source.error.replace(/^source/, "chat.source") };
  if (input.sessions !== undefined) {
    if (!Array.isArray(input.sessions)) return fail("chat.sessions", "expected array");
    for (let index = 0; index < input.sessions.length; index += 1) {
      const session = validateNormalizedSession(input.sessions[index]);
      if (!session.ok) return { ok: false, error: session.error.replace(/^session/, `chat.sessions[${index}]`) };
    }
  }
  return ok(input as NormalizedChat);
}

export function validateNormalizedSession(input: unknown): ValidationResult<NormalizedSession> {
  if (!isRecord(input)) return fail("session", "expected object");
  const id = validateString(input.id, "session.id");
  if (!id.ok) return id;
  const provider = validateProvider(input.provider, "session.provider");
  if (!provider.ok) return provider;
  for (const field of ["chatId", "title"] as const) {
    const result = validateOptionalString(input[field], `session.${field}`);
    if (!result.ok) return result;
  }
  for (const field of ["startedAt", "endedAt"] as const) {
    const result = validateOptionalIsoString(input[field], `session.${field}`);
    if (!result.ok) return result;
  }
  const source = validateSourceMetadata(input.source);
  if (!source.ok) return { ok: false, error: source.error.replace(/^source/, "session.source") };
  if (input.events !== undefined) {
    if (!Array.isArray(input.events)) return fail("session.events", "expected array");
    for (let index = 0; index < input.events.length; index += 1) {
      const event = validateNormalizedEvent(input.events[index]);
      if (!event.ok) return { ok: false, error: event.error.replace(/^event/, `session.events[${index}]`) };
    }
  }
  return ok(input as NormalizedSession);
}

export function validateNormalizedEvent(input: unknown): ValidationResult<NormalizedEvent> {
  if (!isRecord(input)) return fail("event", "expected object");
  const id = validateString(input.id, "event.id");
  if (!id.ok) return id;
  const provider = validateProvider(input.provider, "event.provider");
  if (!provider.ok) return provider;
  if (!oneOf(input.kind, NORMALIZED_EVENT_KINDS)) return fail("event.kind", "expected supported event kind");
  for (const field of ["sessionId", "parentId", "text"] as const) {
    const result = validateOptionalString(input[field], `event.${field}`);
    if (!result.ok) return result;
  }
  if (
    input.role !== undefined &&
    input.role !== "user" &&
    input.role !== "assistant" &&
    input.role !== "system" &&
    input.role !== "tool" &&
    input.role !== "unknown"
  ) {
    return fail("event.role", "expected supported role");
  }
  const createdAt = validateOptionalIsoString(input.createdAt, "event.createdAt");
  if (!createdAt.ok) return createdAt;
  const source = validateSourceMetadata(input.source);
  if (!source.ok) return { ok: false, error: source.error.replace(/^source/, "event.source") };
  return ok(input as NormalizedEvent);
}
