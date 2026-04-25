export const CHAT_SYNC_CONTRACT_VERSION = 1;

export const CHAT_PROVIDERS = ["claude", "codex", "gemini", "unknown"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

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

export type SyncCursor = {
  generation: number;
  offset: number;
  lineNo: number;
  tailHash: string;
};

export type RedactionSummary = {
  applied: boolean;
  rules?: string[];
  counts?: Record<string, number>;
  note?: string;
};

export type SourceMetadata = {
  provider: ChatProvider;
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
  agentId?: string;
  installId: string;
  hostname: string;
  platform: string;
  arch: string;
  version: string;
  osRelease?: string;
  labels?: Record<string, string>;
};

export type AgentCapabilities = {
  providers: ChatProvider[];
  watchKinds: WatchRuleKind[];
  supportsAppendChunks: boolean;
  supportsSnapshots: boolean;
  supportsSqlite: boolean;
  maxChunkBytes?: number;
};

export type AgentHelloRequest = {
  contractVersion: number;
  agent: AgentDescriptor;
  capabilities: AgentCapabilities;
  sentAt?: string;
};

export type AgentHelloResponse = {
  ok: boolean;
  serverId: string;
  serverTime: string;
  policy: ServerSyncPolicy;
  config?: ServerSyncConfig;
  message?: string;
};

export type AgentRegisterRequest = {
  hello: AgentHelloRequest;
  desiredAgentId?: string;
  registrationToken?: string;
};

export type AgentRegisterResponse = {
  ok: boolean;
  agentId?: string;
  token?: string;
  registeredAt?: string;
  policy?: ServerSyncPolicy;
  config?: ServerSyncConfig;
  error?: string;
  retryAfterMs?: number;
};

export type WatchRuleBase = {
  id: string;
  kind: WatchRuleKind;
  enabled?: boolean;
  provider?: ChatProvider;
  path: string;
  fileIdPrefix?: string;
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

export type ServerSyncPolicy = {
  revision: string;
  maxChunkBytes: number;
  maxInventoryFiles: number;
  heartbeatIntervalMs: number;
  uploadConcurrency: number;
  allowProviders: ChatProvider[];
  watchRules: WatchRule[];
  requireTailHash?: boolean;
  retentionDays?: number;
  redaction?: {
    enabled: boolean;
    patterns?: string[];
  };
};

export type ServerSyncConfig = {
  contractVersion: number;
  serverId: string;
  generatedAt: string;
  policy: ServerSyncPolicy;
  endpoints?: {
    hello?: string;
    register?: string;
    inventory?: string;
    appendChunk?: string;
  };
};

export type InventoryFileReport = {
  provider: ChatProvider;
  sourcePath: string;
  fileId: string;
  ruleId: string;
  ruleKind: WatchRuleKind;
  sizeBytes: number;
  mtimeMs: number;
  generation: number;
  cursor?: SyncCursor;
  contentSha256?: string;
  tailHash?: string;
  deleted?: boolean;
};

export type InventoryReport = {
  agentId: string;
  reportedAt: string;
  files: InventoryFileReport[];
  summary?: {
    totalFiles: number;
    totalBytes: number;
    ignoredFiles?: number;
  };
};

export type AppendChunkUpload = {
  agentId: string;
  provider: ChatProvider;
  sourcePath: string;
  fileId: string;
  cursor: SyncCursor;
  chunk: {
    encoding: "utf8";
    text: string;
    byteLength: number;
    lineCount?: number;
    sha256?: string;
    tailHash?: string;
  };
  observedAt?: string;
};

export type AppendChunkAck = {
  ok: boolean;
  fileId: string;
  cursor: SyncCursor;
  acceptedBytes: number;
  acceptedLines?: number;
  duplicate?: boolean;
  nextCursor?: SyncCursor;
  error?: string;
};

export type NormalizedChat = {
  id: string;
  provider: ChatProvider;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  source: SourceMetadata;
  sessions?: NormalizedSession[];
};

export type NormalizedSession = {
  id: string;
  chatId?: string;
  provider: ChatProvider;
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
  provider: ChatProvider;
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

function validateStringRecord(value: unknown, path: string): ValidationResult<Record<string, string> | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return fail(path, "expected object");
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return fail(`${path}.${key}`, "expected string");
  }
  return ok(value as Record<string, string>);
}

function validateStringArray(value: unknown, path: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return fail(path, "expected array");
  for (let index = 0; index < value.length; index += 1) {
    if (!isString(value[index])) return fail(`${path}[${index}]`, "expected non-empty string");
  }
  return ok(value);
}

function validateEnumArray<T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
): ValidationResult<T[number][]> {
  if (!Array.isArray(value)) return fail(path, "expected array");
  for (let index = 0; index < value.length; index += 1) {
    if (!oneOf(value[index], values)) return fail(`${path}[${index}]`, `expected one of ${values.join(", ")}`);
  }
  return ok(value as T[number][]);
}

function validateOptionalPositiveInteger(value: unknown, path: string): ValidationResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return isPositiveInteger(value) ? ok(value) : fail(path, "expected positive integer");
}

function validateOptionalNonNegativeInteger(value: unknown, path: string): ValidationResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return isNonNegativeInteger(value) ? ok(value) : fail(path, "expected non-negative integer");
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

export function validateSyncCursor(input: unknown): ValidationResult<SyncCursor> {
  if (!isRecord(input)) return fail("cursor", "expected object");
  if (!isNonNegativeInteger(input.generation)) return fail("cursor.generation", "expected non-negative integer");
  if (!isNonNegativeInteger(input.offset)) return fail("cursor.offset", "expected non-negative integer");
  if (!isNonNegativeInteger(input.lineNo)) return fail("cursor.lineNo", "expected non-negative integer");
  const tailHash = validateString(input.tailHash, "cursor.tailHash");
  if (!tailHash.ok) return tailHash;
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
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("source.provider", "expected supported provider");
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
  for (const field of ["installId", "hostname", "platform", "arch", "version"] as const) {
    const result = validateString(input[field], `agent.${field}`);
    if (!result.ok) return result;
  }
  const agentId = validateOptionalString(input.agentId, "agent.agentId");
  if (!agentId.ok) return agentId;
  const osRelease = validateOptionalString(input.osRelease, "agent.osRelease");
  if (!osRelease.ok) return osRelease;
  const labels = validateStringRecord(input.labels, "agent.labels");
  if (!labels.ok) return labels;
  return ok(input as AgentDescriptor);
}

export function validateAgentCapabilities(input: unknown): ValidationResult<AgentCapabilities> {
  if (!isRecord(input)) return fail("capabilities", "expected object");
  const providers = validateEnumArray(input.providers, "capabilities.providers", CHAT_PROVIDERS);
  if (!providers.ok) return providers;
  const watchKinds = validateEnumArray(input.watchKinds, "capabilities.watchKinds", WATCH_RULE_KINDS);
  if (!watchKinds.ok) return watchKinds;
  for (const field of ["supportsAppendChunks", "supportsSnapshots", "supportsSqlite"] as const) {
    if (typeof input[field] !== "boolean") return fail(`capabilities.${field}`, "expected boolean");
  }
  const maxChunkBytes = validateOptionalPositiveInteger(input.maxChunkBytes, "capabilities.maxChunkBytes");
  if (!maxChunkBytes.ok) return maxChunkBytes;
  return ok(input as AgentCapabilities);
}

export function validateAgentHelloRequest(input: unknown): ValidationResult<AgentHelloRequest> {
  if (!isRecord(input)) return fail("hello", "expected object");
  if (input.contractVersion !== CHAT_SYNC_CONTRACT_VERSION) {
    return fail("hello.contractVersion", `expected ${CHAT_SYNC_CONTRACT_VERSION}`);
  }
  const agent = validateAgentDescriptor(input.agent);
  if (!agent.ok) return agent;
  const capabilities = validateAgentCapabilities(input.capabilities);
  if (!capabilities.ok) return capabilities;
  const sentAt = validateOptionalIsoString(input.sentAt, "hello.sentAt");
  if (!sentAt.ok) return sentAt;
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
  if (input.provider !== undefined && !oneOf(input.provider, CHAT_PROVIDERS)) {
    return fail("watchRule.provider", "expected supported provider");
  }
  const fileIdPrefix = validateOptionalString(input.fileIdPrefix, "watchRule.fileIdPrefix");
  if (!fileIdPrefix.ok) return fileIdPrefix;
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

export function validateServerSyncPolicy(input: unknown): ValidationResult<ServerSyncPolicy> {
  if (!isRecord(input)) return fail("policy", "expected object");
  const revision = validateString(input.revision, "policy.revision");
  if (!revision.ok) return revision;
  for (const field of ["maxChunkBytes", "maxInventoryFiles", "heartbeatIntervalMs", "uploadConcurrency"] as const) {
    if (!isPositiveInteger(input[field])) return fail(`policy.${field}`, "expected positive integer");
  }
  const providers = validateEnumArray(input.allowProviders, "policy.allowProviders", CHAT_PROVIDERS);
  if (!providers.ok) return providers;
  if (!Array.isArray(input.watchRules)) return fail("policy.watchRules", "expected array");
  for (let index = 0; index < input.watchRules.length; index += 1) {
    const rule = validateWatchRule(input.watchRules[index]);
    if (!rule.ok) return { ok: false, error: rule.error.replace(/^watchRule/, `policy.watchRules[${index}]`) };
  }
  const requireTailHash = validateOptionalBoolean(input.requireTailHash, "policy.requireTailHash");
  if (!requireTailHash.ok) return requireTailHash;
  const retentionDays = validateOptionalPositiveInteger(input.retentionDays, "policy.retentionDays");
  if (!retentionDays.ok) return retentionDays;
  if (input.redaction !== undefined) {
    if (!isRecord(input.redaction)) return fail("policy.redaction", "expected object");
    if (typeof input.redaction.enabled !== "boolean") return fail("policy.redaction.enabled", "expected boolean");
    if (input.redaction.patterns !== undefined) {
      const patterns = validateStringArray(input.redaction.patterns, "policy.redaction.patterns");
      if (!patterns.ok) return patterns;
    }
  }
  return ok(input as ServerSyncPolicy);
}

export function validateServerSyncConfig(input: unknown): ValidationResult<ServerSyncConfig> {
  if (!isRecord(input)) return fail("config", "expected object");
  if (input.contractVersion !== CHAT_SYNC_CONTRACT_VERSION) {
    return fail("config.contractVersion", `expected ${CHAT_SYNC_CONTRACT_VERSION}`);
  }
  const serverId = validateString(input.serverId, "config.serverId");
  if (!serverId.ok) return serverId;
  const generatedAt = validateOptionalIsoString(input.generatedAt, "config.generatedAt");
  if (!generatedAt.ok || generatedAt.value === undefined) return fail("config.generatedAt", "expected parseable date-time string");
  const policy = validateServerSyncPolicy(input.policy);
  if (!policy.ok) return policy;
  if (input.endpoints !== undefined) {
    if (!isRecord(input.endpoints)) return fail("config.endpoints", "expected object");
    for (const field of ["hello", "register", "inventory", "appendChunk"] as const) {
      const endpoint = validateOptionalString(input.endpoints[field], `config.endpoints.${field}`);
      if (!endpoint.ok) return endpoint;
    }
  }
  return ok(input as ServerSyncConfig);
}

export function validateAgentHelloResponse(input: unknown): ValidationResult<AgentHelloResponse> {
  if (!isRecord(input)) return fail("helloResponse", "expected object");
  if (typeof input.ok !== "boolean") return fail("helloResponse.ok", "expected boolean");
  const serverId = validateString(input.serverId, "helloResponse.serverId");
  if (!serverId.ok) return serverId;
  const serverTime = validateOptionalIsoString(input.serverTime, "helloResponse.serverTime");
  if (!serverTime.ok || serverTime.value === undefined) return fail("helloResponse.serverTime", "expected parseable date-time string");
  const policy = validateServerSyncPolicy(input.policy);
  if (!policy.ok) return policy;
  if (input.config !== undefined) {
    const config = validateServerSyncConfig(input.config);
    if (!config.ok) return config;
  }
  const message = validateOptionalString(input.message, "helloResponse.message");
  if (!message.ok) return message;
  return ok(input as AgentHelloResponse);
}

export function validateAgentRegisterRequest(input: unknown): ValidationResult<AgentRegisterRequest> {
  if (!isRecord(input)) return fail("register", "expected object");
  const hello = validateAgentHelloRequest(input.hello);
  if (!hello.ok) return hello;
  const desiredAgentId = validateOptionalString(input.desiredAgentId, "register.desiredAgentId");
  if (!desiredAgentId.ok) return desiredAgentId;
  const registrationToken = validateOptionalString(input.registrationToken, "register.registrationToken");
  if (!registrationToken.ok) return registrationToken;
  return ok(input as AgentRegisterRequest);
}

export function validateAgentRegisterResponse(input: unknown): ValidationResult<AgentRegisterResponse> {
  if (!isRecord(input)) return fail("registerResponse", "expected object");
  if (typeof input.ok !== "boolean") return fail("registerResponse.ok", "expected boolean");
  if (input.ok) {
    const agentId = validateString(input.agentId, "registerResponse.agentId");
    if (!agentId.ok) return agentId;
    const registeredAt = validateOptionalIsoString(input.registeredAt, "registerResponse.registeredAt");
    if (!registeredAt.ok || registeredAt.value === undefined) {
      return fail("registerResponse.registeredAt", "expected parseable date-time string");
    }
  } else {
    const error = validateString(input.error, "registerResponse.error");
    if (!error.ok) return error;
  }
  const token = validateOptionalString(input.token, "registerResponse.token");
  if (!token.ok) return token;
  if (input.policy !== undefined) {
    const policy = validateServerSyncPolicy(input.policy);
    if (!policy.ok) return policy;
  }
  if (input.config !== undefined) {
    const config = validateServerSyncConfig(input.config);
    if (!config.ok) return config;
  }
  const retryAfterMs = validateOptionalPositiveInteger(input.retryAfterMs, "registerResponse.retryAfterMs");
  if (!retryAfterMs.ok) return retryAfterMs;
  return ok(input as AgentRegisterResponse);
}

export function validateInventoryFileReport(input: unknown): ValidationResult<InventoryFileReport> {
  if (!isRecord(input)) return fail("inventoryFile", "expected object");
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("inventoryFile.provider", "expected supported provider");
  for (const field of ["sourcePath", "fileId", "ruleId"] as const) {
    const result = validateString(input[field], `inventoryFile.${field}`);
    if (!result.ok) return result;
  }
  if (!oneOf(input.ruleKind, WATCH_RULE_KINDS)) return fail("inventoryFile.ruleKind", "expected supported watch rule kind");
  for (const field of ["sizeBytes", "generation"] as const) {
    if (!isNonNegativeInteger(input[field])) return fail(`inventoryFile.${field}`, "expected non-negative integer");
  }
  if (!isFiniteNumber(input.mtimeMs) || input.mtimeMs < 0) return fail("inventoryFile.mtimeMs", "expected non-negative number");
  if (input.cursor !== undefined) {
    const cursor = validateSyncCursor(input.cursor);
    if (!cursor.ok) return { ok: false, error: cursor.error.replace(/^cursor/, "inventoryFile.cursor") };
  }
  for (const field of ["contentSha256", "tailHash"] as const) {
    const result = validateOptionalString(input[field], `inventoryFile.${field}`);
    if (!result.ok) return result;
  }
  const deleted = validateOptionalBoolean(input.deleted, "inventoryFile.deleted");
  if (!deleted.ok) return deleted;
  return ok(input as InventoryFileReport);
}

export function validateInventoryReport(input: unknown): ValidationResult<InventoryReport> {
  if (!isRecord(input)) return fail("inventory", "expected object");
  const agentId = validateString(input.agentId, "inventory.agentId");
  if (!agentId.ok) return agentId;
  const reportedAt = validateOptionalIsoString(input.reportedAt, "inventory.reportedAt");
  if (!reportedAt.ok || reportedAt.value === undefined) return fail("inventory.reportedAt", "expected parseable date-time string");
  if (!Array.isArray(input.files)) return fail("inventory.files", "expected array");
  for (let index = 0; index < input.files.length; index += 1) {
    const file = validateInventoryFileReport(input.files[index]);
    if (!file.ok) return { ok: false, error: file.error.replace(/^inventoryFile/, `inventory.files[${index}]`) };
  }
  if (input.summary !== undefined) {
    if (!isRecord(input.summary)) return fail("inventory.summary", "expected object");
    for (const field of ["totalFiles", "totalBytes"] as const) {
      if (!isNonNegativeInteger(input.summary[field])) return fail(`inventory.summary.${field}`, "expected non-negative integer");
    }
    const ignoredFiles = validateOptionalNonNegativeInteger(input.summary.ignoredFiles, "inventory.summary.ignoredFiles");
    if (!ignoredFiles.ok) return ignoredFiles;
  }
  return ok(input as InventoryReport);
}

export function validateAppendChunkUpload(input: unknown): ValidationResult<AppendChunkUpload> {
  if (!isRecord(input)) return fail("appendChunk", "expected object");
  const agentId = validateString(input.agentId, "appendChunk.agentId");
  if (!agentId.ok) return agentId;
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("appendChunk.provider", "expected supported provider");
  for (const field of ["sourcePath", "fileId"] as const) {
    const result = validateString(input[field], `appendChunk.${field}`);
    if (!result.ok) return result;
  }
  const cursor = validateSyncCursor(input.cursor);
  if (!cursor.ok) return { ok: false, error: cursor.error.replace(/^cursor/, "appendChunk.cursor") };
  if (!isRecord(input.chunk)) return fail("appendChunk.chunk", "expected object");
  if (input.chunk.encoding !== "utf8") return fail("appendChunk.chunk.encoding", "expected utf8");
  const text = validateString(input.chunk.text, "appendChunk.chunk.text");
  if (!text.ok) return text;
  if (!isNonNegativeInteger(input.chunk.byteLength)) return fail("appendChunk.chunk.byteLength", "expected non-negative integer");
  const lineCount = validateOptionalNonNegativeInteger(input.chunk.lineCount, "appendChunk.chunk.lineCount");
  if (!lineCount.ok) return lineCount;
  for (const field of ["sha256", "tailHash"] as const) {
    const result = validateOptionalString(input.chunk[field], `appendChunk.chunk.${field}`);
    if (!result.ok) return result;
  }
  const observedAt = validateOptionalIsoString(input.observedAt, "appendChunk.observedAt");
  if (!observedAt.ok) return observedAt;
  return ok(input as AppendChunkUpload);
}

export function validateAppendChunkAck(input: unknown): ValidationResult<AppendChunkAck> {
  if (!isRecord(input)) return fail("appendAck", "expected object");
  if (typeof input.ok !== "boolean") return fail("appendAck.ok", "expected boolean");
  const fileId = validateString(input.fileId, "appendAck.fileId");
  if (!fileId.ok) return fileId;
  const cursor = validateSyncCursor(input.cursor);
  if (!cursor.ok) return { ok: false, error: cursor.error.replace(/^cursor/, "appendAck.cursor") };
  if (!isNonNegativeInteger(input.acceptedBytes)) return fail("appendAck.acceptedBytes", "expected non-negative integer");
  const acceptedLines = validateOptionalNonNegativeInteger(input.acceptedLines, "appendAck.acceptedLines");
  if (!acceptedLines.ok) return acceptedLines;
  const duplicate = validateOptionalBoolean(input.duplicate, "appendAck.duplicate");
  if (!duplicate.ok) return duplicate;
  if (input.nextCursor !== undefined) {
    const nextCursor = validateSyncCursor(input.nextCursor);
    if (!nextCursor.ok) return { ok: false, error: nextCursor.error.replace(/^cursor/, "appendAck.nextCursor") };
  }
  const error = validateOptionalString(input.error, "appendAck.error");
  if (!error.ok) return error;
  return ok(input as AppendChunkAck);
}

export function validateNormalizedChat(input: unknown): ValidationResult<NormalizedChat> {
  if (!isRecord(input)) return fail("chat", "expected object");
  const id = validateString(input.id, "chat.id");
  if (!id.ok) return id;
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("chat.provider", "expected supported provider");
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
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("session.provider", "expected supported provider");
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
  if (!oneOf(input.provider, CHAT_PROVIDERS)) return fail("event.provider", "expected supported provider");
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
