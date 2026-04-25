import { createHash } from "node:crypto";
import { basename } from "node:path";

export const syncEnginePolicy = {
  protocol: "agent-v1",
  enabled: true,
  uploadsEnabled: true,
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadLines: 250,
  scanRoots: ["claude", "codex", "gemini"],
  ignorePatterns: [
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
    "auth.json",
    "oauth_creds.json",
    "google_accounts.json",
    "Cookies",
    "Local Storage",
    "**/Cache/**",
    "**/Code Cache/**",
    "**/.tmp/**",
    "**/tmp/**",
  ],
  requestLimits: {
    helloBytes: 128 * 1024,
    inventoryBytes: 2 * 1024 * 1024,
    appendBytes: 4 * 1024 * 1024,
    filesPerInventory: 1000,
    chunksPerAppend: 100,
    eventsPerAppend: 1000,
    rawChunkBytes: 256 * 1024,
    metadataBytes: 64 * 1024,
    normalizedEventBytes: 128 * 1024,
  },
  storage: {
    rawChunks: "hash_only",
    rawFilesStoredByDefault: false,
  },
  providers: ["claude", "codex", "gemini", "path", "unknown"],
  cursors: {
    defaultScope: "global",
  },
} as const;

const sensitiveKeyPattern = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const longSecretPattern = /\b(?:sk-[A-Za-z0-9]{16,}|[A-Za-z0-9_/-]{32,})\b/g;

type SyncAgent = {
  agentId: string;
  hostname: string;
  platform?: string | null;
  arch?: string | null;
  version?: string | null;
  sourceRoot?: string | null;
};

type SourceFileInput = {
  sourcePath: string;
  provider: string;
  sourceKind: string;
  pathSha256: string;
  sizeBytes: number;
  mtimeMs: number | null;
  contentSha256: string | null;
  mimeType: string | null;
  encoding: string | null;
  lineCount: number | null;
  git: Record<string, unknown>;
  metadata: Record<string, unknown>;
  redaction: Record<string, unknown>;
  deleted: boolean;
};

type AppendChunkInput = {
  chunkId: string;
  sequence: number | null;
  cursorStart: string | null;
  cursorEnd: string | null;
  rawSha256: string | null;
  rawBytes: number;
  compression: string | null;
  encoding: string | null;
  contentType: string | null;
  metadata: Record<string, unknown>;
  redaction: Record<string, unknown>;
  events: NormalizedEventInput[];
};

type NormalizedEventInput = {
  eventUid: string | null;
  eventType: string | null;
  role: string | null;
  occurredAt: string | null;
  sourceOffset: number | null;
  sourceLineNo: number | null;
  contentSha256: string | null;
  metadata: Record<string, unknown>;
  redaction: Record<string, unknown>;
  normalized: Record<string, unknown>;
};

export class SyncEngineHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isSyncEngineHttpError(error: unknown): error is SyncEngineHttpError {
  return error instanceof SyncEngineHttpError;
}

export async function handleAgentHello(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.helloBytes);
  const agent = normalizeAgent(body.agent);
  await upsertAgent(sql, agent);

  return {
    ok: true,
    protocol: syncEnginePolicy.protocol,
    serverTime: new Date().toISOString(),
    agentId: agent.agentId,
    policy: buildSyncPolicy(body),
  };
}

export async function handleAgentInventory(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.inventoryBytes);
  const agent = normalizeAgent(body.agent);
  const files = normalizeInventoryFiles(body);
  await upsertAgent(sql, agent);

  let acceptedFiles = 0;
  let deletedFiles = 0;
  const fileIds: string[] = [];

  await sql.transaction(async (tx: any) => {
    for (const file of files) {
      const rows = await upsertSourceFile(tx, agent.agentId, file);
      if (rows[0]?.id != null) fileIds.push(String(rows[0].id));
      acceptedFiles++;
      if (file.deleted) deletedFiles++;
    }

    const cursor = normalizeCursor(body.cursor, "inventory");
    if (cursor) {
      await upsertCursor(tx, agent.agentId, cursor.scope, null, cursor.value, cursor.metadata);
    }
  });

  return {
    ok: true,
    acceptedFiles,
    deletedFiles,
    fileIds,
    policy: buildSyncPolicy(body),
  };
}

export async function handleAgentAppend(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.appendBytes);
  const agent = normalizeAgent(body.agent);
  const source = normalizeAppendSource(body.source ?? body.file ?? body);
  const chunks = normalizeAppendChunks(body);
  await upsertAgent(sql, agent);

  let acceptedChunks = 0;
  let acceptedEvents = 0;
  let ackCursor = "0";
  let sourceFileId = "";

  await sql.transaction(async (tx: any) => {
    const sourceRows = await upsertSourceFile(tx, agent.agentId, source);
    sourceFileId = String(sourceRows[0].id);

    for (const chunk of chunks) {
      const chunkRows = await tx`
        insert into agent_raw_chunks (
          source_file_id,
          agent_id,
          chunk_id,
          sequence,
          cursor_start,
          cursor_end,
          raw_sha256,
          raw_bytes,
          raw_body,
          raw_text,
          compression,
          encoding,
          content_type,
          redaction,
          metadata
        )
        values (
          ${sourceRows[0].id},
          ${agent.agentId},
          ${chunk.chunkId},
          ${chunk.sequence},
          ${chunk.cursorStart},
          ${chunk.cursorEnd},
          ${chunk.rawSha256},
          ${chunk.rawBytes},
          ${null},
          ${null},
          ${chunk.compression},
          ${chunk.encoding},
          ${chunk.contentType},
          ${chunk.redaction}::jsonb,
          ${chunk.metadata}::jsonb
        )
        on conflict (agent_id, source_file_id, chunk_id) do update set
          cursor_start = coalesce(excluded.cursor_start, agent_raw_chunks.cursor_start),
          cursor_end = coalesce(excluded.cursor_end, agent_raw_chunks.cursor_end),
          raw_sha256 = coalesce(excluded.raw_sha256, agent_raw_chunks.raw_sha256),
          raw_bytes = excluded.raw_bytes,
          redaction = agent_raw_chunks.redaction || excluded.redaction,
          metadata = agent_raw_chunks.metadata || excluded.metadata
        returning id
      `;
      acceptedChunks++;
      if (chunk.cursorEnd) ackCursor = chunk.cursorEnd;
      else ackCursor = String(chunkRows[0].id);

      for (const event of chunk.events) {
        await tx`
          insert into agent_normalized_events (
            raw_chunk_id,
            source_file_id,
            agent_id,
            provider,
            event_uid,
            event_type,
            role,
            occurred_at,
            source_offset,
            source_line_no,
            content_sha256,
            metadata,
            redaction,
            normalized
          )
          values (
            ${chunkRows[0].id},
            ${sourceRows[0].id},
            ${agent.agentId},
            ${source.provider},
            ${event.eventUid},
            ${event.eventType},
            ${event.role},
            ${event.occurredAt},
            ${event.sourceOffset},
            ${event.sourceLineNo},
            ${event.contentSha256},
            ${event.metadata}::jsonb,
            ${event.redaction}::jsonb,
            ${event.normalized}::jsonb
          )
          on conflict (agent_id, source_file_id, event_uid) where event_uid is not null do update set
            raw_chunk_id = excluded.raw_chunk_id,
            event_type = coalesce(excluded.event_type, agent_normalized_events.event_type),
            role = coalesce(excluded.role, agent_normalized_events.role),
            occurred_at = coalesce(excluded.occurred_at, agent_normalized_events.occurred_at),
            source_offset = coalesce(excluded.source_offset, agent_normalized_events.source_offset),
            source_line_no = coalesce(excluded.source_line_no, agent_normalized_events.source_line_no),
            content_sha256 = coalesce(excluded.content_sha256, agent_normalized_events.content_sha256),
            metadata = agent_normalized_events.metadata || excluded.metadata,
            redaction = agent_normalized_events.redaction || excluded.redaction,
            normalized = excluded.normalized
        `;
        acceptedEvents++;
      }
    }

    const cursor = normalizeCursor(body.cursor, "append") ?? { scope: "append", value: ackCursor, metadata: {} };
    await upsertCursor(tx, agent.agentId, cursor.scope, sourceRows[0].id, ackCursor, cursor.metadata);
  });

  return {
    ok: true,
    sourceFileId,
    acceptedChunks,
    acceptedEvents,
    cursor: ackCursor,
    storage: syncEnginePolicy.storage,
  };
}

export function buildSyncPolicy(_input?: unknown) {
  return {
    ...syncEnginePolicy,
    maxUploadChunkBytes: syncEnginePolicy.requestLimits.rawChunkBytes,
    watchRules: [
      {
        id: "claude-project-jsonl",
        kind: "append_jsonl",
        provider: "claude",
        path: "~/.claude/projects/**/*.jsonl",
        maxBytes: syncEnginePolicy.requestLimits.rawChunkBytes,
        maxRecords: syncEnginePolicy.maxUploadLines,
      },
      {
        id: "codex-session-jsonl",
        kind: "append_jsonl",
        provider: "codex",
        path: "~/.codex/sessions/**/*.jsonl",
        maxBytes: syncEnginePolicy.requestLimits.rawChunkBytes,
        maxRecords: syncEnginePolicy.maxUploadLines,
      },
      {
        id: "codex-state-sqlite",
        kind: "sqlite_reader",
        provider: "codex",
        path: "~/.codex/state_5.sqlite",
        query: "threads",
      },
      {
        id: "sensitive-auth-files",
        kind: "ignore",
        path: "**/{auth.json,oauth_creds.json,google_accounts.json,Cookies,Local Storage}/**",
        reason: "known sensitive local auth material",
      },
      {
        id: "cache-noise",
        kind: "ignore",
        path: "**/{Cache,Code Cache,.tmp,tmp}/**",
        reason: "high-volume cache or temporary files",
      },
    ],
    serverGeneratedAt: new Date().toISOString(),
  };
}

export function validateHelloPayload(value: unknown) {
  const body = assertObject(value, "payload");
  return {
    agent: normalizeAgent(body.agent),
    policy: buildSyncPolicy(body),
  };
}

export function validateInventoryPayload(value: unknown) {
  const body = assertObject(value, "payload");
  return {
    agent: normalizeAgent(body.agent),
    files: normalizeInventoryFiles(body),
  };
}

export function validateAppendPayload(value: unknown) {
  const body = assertObject(value, "payload");
  return {
    agent: normalizeAgent(body.agent),
    source: normalizeAppendSource(body.source ?? body.file ?? body),
    chunks: normalizeAppendChunks(body),
  };
}

export function redactMetadata(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value, "$", new Set<object>());
  if (!isPlainObject(redacted)) return {};
  return redacted;
}

async function readJsonObject(req: Request, maxBytes: number) {
  const declaredBytes = Number(req.headers.get("content-length") ?? 0);
  if (declaredBytes > maxBytes) throw new SyncEngineHttpError(413, "request body too large");

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > maxBytes) throw new SyncEngineHttpError(413, "request body too large");

  try {
    return assertObject(JSON.parse(bytes.toString("utf8")), "payload");
  } catch (error) {
    if (error instanceof SyncEngineHttpError) throw error;
    throw new SyncEngineHttpError(400, "invalid json payload");
  }
}

function normalizeAgent(value: unknown): SyncAgent {
  const agent = assertObject(value, "agent");
  const agentId = stringField(agent, "agentId", { max: 160 });
  return {
    agentId,
    hostname: optionalString(agent.hostname, { max: 255 }) ?? "unknown",
    platform: optionalString(agent.platform, { max: 80 }),
    arch: optionalString(agent.arch, { max: 80 }),
    version: optionalString(agent.version, { max: 120 }),
    sourceRoot: optionalString(agent.sourceRoot, { max: 4096 }),
  };
}

function normalizeInventoryFiles(body: Record<string, unknown>) {
  const files = arrayField(body.files, "files", syncEnginePolicy.requestLimits.filesPerInventory);
  return files.map((file, index) => normalizeSourceFile(file, `files[${index}]`));
}

function normalizeAppendSource(value: unknown) {
  return normalizeSourceFile(value, "source", { allowMissingSize: true });
}

function normalizeSourceFile(
  value: unknown,
  label: string,
  options: { allowMissingSize?: boolean } = {},
): SourceFileInput {
  const file = assertObject(value, label);
  const sourcePath = optionalString(file.sourcePath, { max: 4096 }) ?? optionalString(file.path, { max: 4096 });
  if (!sourcePath) throw new SyncEngineHttpError(400, `${label}.sourcePath is required`);
  const storedSourcePath = safeStoredSourcePath(file, sourcePath);

  const git = redactMetadata(file.git);
  const metadata = limitMetadata(redactMetadata(file.metadata), `${label}.metadata`);
  return {
    sourcePath: storedSourcePath,
    provider: normalizeProvider(file.provider),
    sourceKind: optionalString(file.sourceKind, { max: 80 }) ?? optionalString(file.kind, { max: 80 }) ?? "conversation",
    pathSha256: optionalSha256(file.pathSha256) ?? sha256Hex(Buffer.from(sourcePath, "utf8")),
    sizeBytes: optionalNonNegativeInteger(file.sizeBytes, `${label}.sizeBytes`) ?? (options.allowMissingSize ? 0 : requiredNumber(file.sizeBytes, `${label}.sizeBytes`)),
    mtimeMs: optionalNumber(file.mtimeMs, `${label}.mtimeMs`),
    contentSha256: optionalSha256(file.contentSha256),
    mimeType: optionalString(file.mimeType, { max: 255 }),
    encoding: optionalString(file.encoding, { max: 80 }),
    lineCount: optionalNonNegativeInteger(file.lineCount, `${label}.lineCount`),
    git,
    metadata,
    redaction: {
      ...limitMetadata(redactMetadata(file.redaction), `${label}.redaction`),
      metadataRedacted: true,
    },
    deleted: file.deleted === true,
  };
}

function normalizeAppendChunks(body: Record<string, unknown>) {
  const chunks = arrayField(body.chunks, "chunks", syncEnginePolicy.requestLimits.chunksPerAppend);
  let eventCount = 0;
  return chunks.map((chunk, index) => {
    const normalized = normalizeAppendChunk(chunk, `chunks[${index}]`);
    eventCount += normalized.events.length;
    if (eventCount > syncEnginePolicy.requestLimits.eventsPerAppend) {
      throw new SyncEngineHttpError(400, "too many append events");
    }
    return normalized;
  });
}

function normalizeAppendChunk(value: unknown, label: string): AppendChunkInput {
  const chunk = assertObject(value, label);
  const raw = readRawChunk(chunk, label);
  const events = Array.isArray(chunk.events)
    ? arrayField(chunk.events, `${label}.events`, syncEnginePolicy.requestLimits.eventsPerAppend).map((event, index) =>
        normalizeNormalizedEvent(event, `${label}.events[${index}]`),
      )
    : [];

  return {
    chunkId: optionalString(chunk.chunkId, { max: 200 }) ?? raw.rawSha256 ?? sha256Hex(Buffer.from(`${label}:${Date.now()}`)),
    sequence: optionalNonNegativeInteger(chunk.sequence, `${label}.sequence`),
    cursorStart: optionalString(chunk.cursorStart, { max: 200 }),
    cursorEnd: optionalString(chunk.cursorEnd, { max: 200 }),
    rawSha256: raw.rawSha256 ?? optionalSha256(chunk.rawSha256),
    rawBytes: raw.rawBytes ?? optionalNonNegativeInteger(chunk.rawBytes, `${label}.rawBytes`) ?? 0,
    compression: optionalString(chunk.compression, { max: 80 }),
    encoding: optionalString(chunk.encoding, { max: 80 }),
    contentType: optionalString(chunk.contentType, { max: 255 }),
    metadata: limitMetadata(redactMetadata(chunk.metadata), `${label}.metadata`),
    redaction: {
      ...limitMetadata(redactMetadata(chunk.redaction), `${label}.redaction`),
      storedRaw: false,
      rawPolicy: syncEnginePolicy.storage.rawChunks,
      applied: ["raw_not_stored", "metadata_redacted"],
    },
    events,
  };
}

function normalizeNormalizedEvent(value: unknown, label: string): NormalizedEventInput {
  const event = assertObject(value, label);
  const source = isPlainObject(event.source) ? event.source : {};
  const normalized = limitMetadata(safeNormalizedEvent(event), `${label}.normalized`, syncEnginePolicy.requestLimits.normalizedEventBytes);
  const sourceOffset = optionalNonNegativeInteger(event.sourceOffset ?? event.offset ?? source.byteOffset ?? source.offset, `${label}.sourceOffset`);
  const sourceLineNo = optionalNonNegativeInteger(event.sourceLineNo ?? event.lineNo ?? source.lineNo, `${label}.sourceLineNo`);
  const contentSha256 = optionalSha256(event.contentSha256 ?? event.sha256) ?? sha256Hex(Buffer.from(JSON.stringify(normalized), "utf8"));
  return {
    eventUid:
      optionalString(event.eventUid, { max: 255 }) ??
      optionalString(event.id, { max: 255 }) ??
      stableEventUid(label, sourceLineNo, sourceOffset, contentSha256),
    eventType: optionalString(event.eventType, { max: 120 }) ?? optionalString(event.kind, { max: 120 }) ?? optionalString(event.type, { max: 120 }),
    role: optionalString(event.role, { max: 80 }),
    occurredAt: optionalTimestamp(event.occurredAt ?? event.createdAt),
    sourceOffset,
    sourceLineNo,
    contentSha256,
    metadata: limitMetadata(redactMetadata(event.metadata), `${label}.metadata`),
    redaction: {
      ...limitMetadata(redactMetadata(event.redaction), `${label}.redaction`),
      metadataRedacted: true,
    },
    normalized,
  };
}

function readRawChunk(chunk: Record<string, unknown>, label: string) {
  if (typeof chunk.rawText === "string") {
    const bytes = Buffer.from(chunk.rawText, "utf8");
    assertRawChunkSize(bytes.length, label);
    return { rawSha256: sha256Hex(bytes), rawBytes: bytes.length };
  }

  if (typeof chunk.rawBase64 === "string") {
    const compact = chunk.rawBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new SyncEngineHttpError(400, `${label}.rawBase64 is invalid`);
    const bytes = Buffer.from(compact, "base64");
    assertRawChunkSize(bytes.length, label);
    return { rawSha256: sha256Hex(bytes), rawBytes: bytes.length };
  }

  return { rawSha256: null, rawBytes: null };
}

function safeStoredSourcePath(file: Record<string, unknown>, originalPath: string) {
  const logical =
    optionalString(file.relativePath, { max: 4096 }) ??
    optionalString(file.logicalId, { max: 4096 }) ??
    optionalString(file.fileId, { max: 4096 });
  if (logical) return logical.replace(/^\/+/, "");
  return basename(originalPath) || "<unknown>";
}

function safeNormalizedEvent(event: Record<string, unknown>) {
  const candidate = isPlainObject(event.normalized) ? event.normalized : event;
  const source = isPlainObject(candidate.source) ? candidate.source : isPlainObject(event.source) ? event.source : undefined;
  const output: Record<string, unknown> = {};

  copyAllowed(output, candidate, ["kind", "eventType", "type", "role", "timestamp", "occurredAt", "display", "parts"]);
  if (source) {
    const sourceOutput: Record<string, unknown> = {};
    copyAllowed(sourceOutput, source, ["provider", "sourcePath", "lineNo", "byteOffset", "rawType", "rawKind"]);
    output.source = redactMetadata(sourceOutput);
  }
  return redactMetadata(output);
}

function copyAllowed(output: Record<string, unknown>, source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
}

function stableEventUid(label: string, sourceLineNo: number | null, sourceOffset: number | null, contentSha256: string) {
  return sha256Hex(Buffer.from(`${label}:${sourceLineNo ?? ""}:${sourceOffset ?? ""}:${contentSha256}`, "utf8"));
}

function assertRawChunkSize(bytes: number, label: string) {
  if (bytes > syncEnginePolicy.requestLimits.rawChunkBytes) {
    throw new SyncEngineHttpError(413, `${label} raw chunk too large`);
  }
}

function normalizeCursor(value: unknown, fallbackScope: string) {
  if (value == null) return null;
  const cursor = assertObject(value, "cursor");
  return {
    scope: optionalString(cursor.scope, { max: 120 }) ?? fallbackScope,
    value: optionalString(cursor.value, { max: 255 }) ?? "0",
    metadata: limitMetadata(redactMetadata(cursor.metadata), "cursor.metadata"),
  };
}

async function upsertAgent(sql: any, agent: SyncAgent) {
  await sql`
    insert into agents (id, hostname, platform, arch, version, source_root, last_seen_at)
    values (${agent.agentId}, ${agent.hostname}, ${agent.platform}, ${agent.arch}, ${agent.version}, ${agent.sourceRoot}, now())
    on conflict (id) do update set
      hostname = excluded.hostname,
      platform = coalesce(excluded.platform, agents.platform),
      arch = coalesce(excluded.arch, agents.arch),
      version = coalesce(excluded.version, agents.version),
      source_root = coalesce(excluded.source_root, agents.source_root),
      last_seen_at = now()
  `;
}

async function upsertSourceFile(sql: any, agentId: string, file: SourceFileInput) {
  return await sql`
    insert into agent_source_files (
      agent_id,
      provider,
      source_kind,
      source_path,
      path_sha256,
      size_bytes,
      mtime_ms,
      content_sha256,
      mime_type,
      encoding,
      line_count,
      git,
      metadata,
      redaction,
      deleted_at,
      last_seen_at
    )
    values (
      ${agentId},
      ${file.provider},
      ${file.sourceKind},
      ${file.sourcePath},
      ${file.pathSha256},
      ${file.sizeBytes},
      ${file.mtimeMs},
      ${file.contentSha256},
      ${file.mimeType},
      ${file.encoding},
      ${file.lineCount},
      ${file.git}::jsonb,
      ${file.metadata}::jsonb,
      ${file.redaction}::jsonb,
      case when ${file.deleted}::boolean then now() else null end,
      now()
    )
    on conflict (agent_id, path_sha256) do update set
      provider = excluded.provider,
      source_kind = excluded.source_kind,
      source_path = excluded.source_path,
      size_bytes = excluded.size_bytes,
      mtime_ms = coalesce(excluded.mtime_ms, agent_source_files.mtime_ms),
      content_sha256 = coalesce(excluded.content_sha256, agent_source_files.content_sha256),
      mime_type = coalesce(excluded.mime_type, agent_source_files.mime_type),
      encoding = coalesce(excluded.encoding, agent_source_files.encoding),
      line_count = coalesce(excluded.line_count, agent_source_files.line_count),
      git = agent_source_files.git || excluded.git,
      metadata = agent_source_files.metadata || excluded.metadata,
      redaction = agent_source_files.redaction || excluded.redaction,
      deleted_at = case when excluded.deleted_at is not null then excluded.deleted_at else agent_source_files.deleted_at end,
      last_seen_at = now()
    returning id
  `;
}

async function upsertCursor(
  sql: any,
  agentId: string,
  scope: string,
  sourceFileId: unknown,
  value: string,
  metadata: Record<string, unknown>,
) {
  const sourceFileIdKey = sourceFileId ?? 0;
  await sql`
    insert into agent_sync_cursors (agent_id, source_file_id, source_file_id_key, cursor_scope, cursor_value, metadata, updated_at)
    values (${agentId}, ${sourceFileId}, ${sourceFileIdKey}, ${scope}, ${value}, ${metadata}::jsonb, now())
    on conflict (agent_id, cursor_scope, source_file_id_key) do update set
      cursor_value = excluded.cursor_value,
      metadata = agent_sync_cursors.metadata || excluded.metadata,
      updated_at = now()
  `;
}

function normalizeProvider(value: unknown) {
  const provider = optionalString(value, { max: 80 })?.toLowerCase() ?? "unknown";
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(provider)) throw new SyncEngineHttpError(400, "provider is invalid");
  return provider;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new SyncEngineHttpError(400, `${label} must be an object`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayField(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new SyncEngineHttpError(400, `${label} must be an array`);
  if (value.length > max) throw new SyncEngineHttpError(400, `${label} has too many items`);
  return value;
}

function stringField(object: Record<string, unknown>, key: string, options: { max: number }) {
  const value = optionalString(object[key], options);
  if (!value) throw new SyncEngineHttpError(400, `${key} is required`);
  return value;
}

function optionalString(value: unknown, options: { max: number }) {
  if (value == null) return null;
  if (typeof value !== "string") throw new SyncEngineHttpError(400, "expected string value");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > options.max) throw new SyncEngineHttpError(400, "string value too long");
  return trimmed;
}

function requiredNumber(value: unknown, label: string) {
  const number = optionalNonNegativeInteger(value, label);
  if (number == null) throw new SyncEngineHttpError(400, `${label} is required`);
  return number;
}

function optionalNumber(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SyncEngineHttpError(400, `${label} must be a non-negative number`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SyncEngineHttpError(400, `${label} must be a non-negative integer`);
  }
  return value;
}

function optionalTimestamp(value: unknown) {
  const timestamp = optionalString(value, { max: 80 });
  if (!timestamp) return null;
  if (Number.isNaN(Date.parse(timestamp))) throw new SyncEngineHttpError(400, "timestamp is invalid");
  return timestamp;
}

function optionalSha256(value: unknown) {
  const text = optionalString(value, { max: 64 });
  if (!text) return null;
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new SyncEngineHttpError(400, "sha256 value is invalid");
  return text.toLowerCase();
}

function limitMetadata(value: Record<string, unknown>, label: string, max = syncEnginePolicy.requestLimits.metadataBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > max) throw new SyncEngineHttpError(413, `${label} too large`);
  return value;
}

function redactValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (typeof value === "string") {
    return value.replace(bearerPattern, "Bearer <redacted>").replace(longSecretPattern, "<redacted>");
  }

  if (Array.isArray(value)) return value.slice(0, 200).map((item, index) => redactValue(item, `${path}[${index}]`, seen));

  if (!isPlainObject(value)) return value ?? {};
  if (seen.has(value)) return "<circular>";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    const safeKey = sensitiveKeyPattern.test(key) ? `redacted_key_${sha256Hex(Buffer.from(key, "utf8")).slice(0, 12)}` : key;
    if (sensitiveKeyPattern.test(key)) {
      output[safeKey] = "<redacted>";
    } else {
      output[safeKey] = redactValue(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
  return output;
}

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
