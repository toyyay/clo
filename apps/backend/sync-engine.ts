import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { envValue } from "../../packages/shared/env";
import { sanitizePostgresText } from "./postgres-sanitize";

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

type AgentRuntime = {
  runtimeId: string;
  pid: number | null;
  startedAt: string | null;
  takeover: boolean;
  metadata: Record<string, unknown>;
};

type AgentRuntimeControl = {
  action: "continue" | "shutdown" | "reject";
  reason?: string;
  activeRuntimes?: AgentRuntimeInfo[];
};

type AgentRuntimeInfo = {
  runtimeId: string;
  agentId: string;
  hostname: string;
  pid: number | null;
  startedAt: string | null;
  lastSeenAt: string;
  status: string;
};

type SourceFileInput = {
  sourcePath: string;
  provider: string;
  sourceKind: string;
  sourceGeneration: number;
  pathSha256: string;
  sizeBytes: number;
  mtimeMs: number | null;
  contentSha256: string | null;
  mimeType: string | null;
  encoding: string | null;
  lineCount: number | null;
  rawStorageKey: string | null;
  rawStorageBytes: number | null;
  git: Record<string, unknown>;
  metadata: Record<string, unknown>;
  redaction: Record<string, unknown>;
  deleted: boolean;
};

type AppendChunkInput = {
  chunkId: string;
  appendIdentity: string;
  sourceGeneration: number;
  sequence: number | null;
  cursorStart: string | null;
  cursorEnd: string | null;
  rawSha256: string | null;
  rawBytes: number;
  rawPayload?: Uint8Array;
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

type NormalizeAppendOptions = {
  includeRawPayload?: boolean;
};

export type RawChunkStoragePlan = {
  kind: "hash_only" | "filesystem";
  storageKey: string | null;
  storedRaw: boolean;
  rawBody: null;
  rawText: null;
  reason?: string;
};

export class SyncEngineHttpError extends Error {
  status: number;
  payload?: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export function isSyncEngineHttpError(error: unknown): error is SyncEngineHttpError {
  return error instanceof SyncEngineHttpError;
}

export async function handleAgentHello(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.helloBytes);
  const agent = normalizeAgent(body.agent);
  const runtime = normalizeAgentRuntime(body, agent);
  await upsertAgent(sql, agent);
  const control = runtime ? await registerAgentRuntime(sql, agent, runtime) : null;

  return {
    ok: true,
    protocol: syncEnginePolicy.protocol,
    serverTime: new Date().toISOString(),
    agentId: agent.agentId,
    ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
    ...(control ? { control } : {}),
    policy: buildSyncPolicy(body),
  };
}

export async function handleAgentInventory(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.inventoryBytes);
  const agent = normalizeAgent(body.agent);
  const runtime = normalizeAgentRuntime(body, agent);
  const files = normalizeInventoryFiles(body);
  await upsertAgent(sql, agent);
  await assertRuntimeMayUpload(sql, agent, runtime);

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
      await upsertCursor(tx, agent.agentId, cursor.scope, null, cursor.value, cursor.metadata, 1);
    }
  });

  return {
    ok: true,
    agentId: agent.agentId,
    acceptedFiles,
    deletedFiles,
    fileIds,
    policy: buildSyncPolicy(body),
  };
}

export async function handleAgentAppend(req: Request, sql: any) {
  const body = await readJsonObject(req, syncEnginePolicy.requestLimits.appendBytes);
  const { agent, source, chunks, cursor } = normalizeAppendRequest(body, { includeRawPayload: true });
  const runtime = normalizeAgentRuntime(body, agent);
  await upsertAgent(sql, agent);
  await assertRuntimeMayUpload(sql, agent, runtime);

  let acceptedChunks = 0;
  let acceptedEvents = 0;
  let ackCursor = "0";
  let sourceFileId = "";

  await sql.transaction(async (tx: any) => {
    const sourceRows = await upsertSourceFile(tx, agent.agentId, source);
    sourceFileId = String(sourceRows[0].id);

    for (const chunk of chunks) {
      const storage = await storeRawChunkPayload({
        agentId: agent.agentId,
        sourceFileId: sourceRows[0].id,
        sourceGeneration: chunk.sourceGeneration,
        chunkId: chunk.chunkId,
        rawSha256: chunk.rawSha256,
        rawBytes: chunk.rawBytes,
        rawPayload: chunk.rawPayload,
      });
      const chunkRedaction = rawStorageRedaction(chunk.redaction, storage);
      const chunkRows = await tx`
        insert into agent_raw_chunks (
          source_file_id,
          agent_id,
          source_generation,
          chunk_id,
          sequence,
          cursor_start,
          cursor_end,
          raw_sha256,
          raw_bytes,
          raw_storage_key,
          raw_storage_kind,
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
          ${chunk.sourceGeneration},
          ${chunk.chunkId},
          ${chunk.sequence},
          ${chunk.cursorStart},
          ${chunk.cursorEnd},
          ${chunk.rawSha256},
          ${chunk.rawBytes},
          ${storage.storageKey},
          ${storage.kind},
          ${null},
          ${null},
          ${chunk.compression},
          ${chunk.encoding},
          ${chunk.contentType},
          ${chunkRedaction}::jsonb,
          ${chunk.metadata}::jsonb
        )
        on conflict (agent_id, source_file_id, source_generation, chunk_id) do update set
          cursor_start = coalesce(excluded.cursor_start, agent_raw_chunks.cursor_start),
          cursor_end = coalesce(excluded.cursor_end, agent_raw_chunks.cursor_end),
          raw_sha256 = coalesce(excluded.raw_sha256, agent_raw_chunks.raw_sha256),
          raw_bytes = excluded.raw_bytes,
          raw_storage_key = coalesce(excluded.raw_storage_key, agent_raw_chunks.raw_storage_key),
          raw_storage_kind = case
            when excluded.raw_storage_key is not null then excluded.raw_storage_kind
            else agent_raw_chunks.raw_storage_kind
          end,
          redaction = case
            when excluded.raw_storage_key is null and agent_raw_chunks.raw_storage_key is not null then agent_raw_chunks.redaction
            else agent_raw_chunks.redaction || excluded.redaction
          end,
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
            source_generation,
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
            ${chunk.sourceGeneration},
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
          on conflict (agent_id, source_file_id, source_generation, event_uid) where event_uid is not null do update set
            raw_chunk_id = excluded.raw_chunk_id,
            event_type = coalesce(excluded.event_type, agent_normalized_events.event_type),
            role = coalesce(excluded.role, agent_normalized_events.role),
            occurred_at = coalesce(excluded.occurred_at, agent_normalized_events.occurred_at),
            source_offset = coalesce(excluded.source_offset, agent_normalized_events.source_offset),
            source_line_no = coalesce(excluded.source_line_no, agent_normalized_events.source_line_no),
            content_sha256 = coalesce(excluded.content_sha256, agent_normalized_events.content_sha256),
            metadata = agent_normalized_events.metadata || excluded.metadata,
            redaction = agent_normalized_events.redaction || excluded.redaction,
            normalized = excluded.normalized,
            sync_revision = nextval('sync_event_revision_seq'),
            updated_at = now()
        `;
        acceptedEvents++;
      }
    }

    const cursorMetadata = appendCursorMetadata(cursor?.metadata ?? {}, source.sourceGeneration, chunks.at(-1), ackCursor);
    await upsertCursor(tx, agent.agentId, cursor?.scope ?? "append", sourceRows[0].id, ackCursor, cursorMetadata, source.sourceGeneration);
  });

  return {
    ok: true,
    agentId: agent.agentId,
    sourceFileId,
    acceptedChunks,
    acceptedEvents,
    cursor: ackCursor,
    storage: buildStoragePolicy(),
  };
}

export function buildSyncPolicy(_input?: unknown) {
  return {
    ...syncEnginePolicy,
    storage: buildStoragePolicy(),
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
  return normalizeAppendRequest(body);
}

export function redactMetadata(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value, "$", new Set<object>());
  if (!isPlainObject(redacted)) return {};
  return redacted;
}

export function appendIdentityKey(sourceGeneration: number, chunkId: string) {
  return `g${sourceGeneration}:${chunkId}`;
}

export function planRawChunkStorage(
  input: {
    agentId: string;
    sourceFileId: unknown;
    sourceGeneration: number;
    chunkId: string;
    rawSha256: string | null;
    rawBytes: number;
    hasRawPayload: boolean;
  },
  env: Record<string, string | undefined> = process.env,
): RawChunkStoragePlan {
  const mode = rawSyncStorageMode(env);
  if (!input.rawSha256 || input.rawBytes <= 0 || !input.hasRawPayload) {
    return hashOnlyRawStoragePlan("no_raw_payload");
  }

  const dataDir = rawSyncDataDir(env);
  if (mode !== "filesystem") return hashOnlyRawStoragePlan("filesystem_storage_not_requested");
  if (!dataDir) throw new SyncEngineHttpError(500, "DATA_DIR is required when SYNC_RAW_STORAGE=filesystem");

  return {
    kind: "filesystem",
    storageKey: rawChunkStorageKey(input),
    storedRaw: true,
    rawBody: null,
    rawText: null,
  };
}

function normalizeAppendRequest(body: Record<string, unknown>, options: NormalizeAppendOptions = {}) {
  const sourceValue = body.source ?? body.file ?? body;
  const sourceGeneration = appendSourceGeneration(body, sourceValue);
  const source = normalizeAppendSource(sourceValue, { sourceGeneration });
  const chunks = normalizeAppendChunks(body, source.sourceGeneration, options);
  const cursor = normalizeCursor(body.cursor, "append");
  return {
    agent: normalizeAgent(body.agent),
    source,
    chunks,
    cursor: cursor
      ? {
          ...cursor,
          metadata: appendCursorMetadata(cursor.metadata, source.sourceGeneration, chunks[chunks.length - 1], cursor.value),
        }
      : null,
  };
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

function normalizeAgentRuntime(body: Record<string, unknown>, agent: SyncAgent): AgentRuntime | null {
  const agentValue = isPlainObject(body.agent) ? body.agent : {};
  const runtimeValue = isPlainObject(body.runtime)
    ? body.runtime
    : isPlainObject(agentValue.runtime)
      ? agentValue.runtime
      : optionalString(agentValue.runtimeId, { max: 160 })
        ? agentValue
        : null;
  if (!runtimeValue) return null;

  const runtimeId =
    optionalString(runtimeValue.runtimeId, { max: 160 }) ??
    optionalString(runtimeValue.id, { max: 160 }) ??
    optionalString(runtimeValue.processId, { max: 160 });
  if (!runtimeId) throw new SyncEngineHttpError(400, "runtime.runtimeId is required");

  const control = isPlainObject(body.control) ? body.control : {};
  const takeover =
    runtimeValue.takeover === true ||
    runtimeValue.killExisting === true ||
    runtimeValue.killAll === true ||
    control.takeover === true ||
    control.killExisting === true ||
    control.killAll === true;
  const pid = optionalProcessPid(runtimeValue.pid, "runtime.pid");
  const startedAt = optionalTimestamp(runtimeValue.startedAt ?? runtimeValue.processStartedAt);
  const metadata = limitMetadata(
    redactMetadata({
      ...runtimeValue,
      runtimeId,
      pid,
      startedAt,
      takeover,
      agentId: agent.agentId,
    }),
    "runtime.metadata",
  );

  return {
    runtimeId,
    pid,
    startedAt,
    takeover,
    metadata,
  };
}

async function assertRuntimeMayUpload(sql: any, agent: SyncAgent, runtime: AgentRuntime | null) {
  if (!runtime) return;
  const control = await registerAgentRuntime(sql, agent, runtime);
  if (control.action !== "shutdown") return;
  throw new SyncEngineHttpError(409, "agent runtime shutdown requested", {
    ok: false,
    error: "agent runtime shutdown requested",
    control,
  });
}

async function registerAgentRuntime(sql: any, agent: SyncAgent, runtime: AgentRuntime): Promise<AgentRuntimeControl> {
  return await sql.transaction(async (tx: any) => {
    const activeRows = await tx`
      select runtime_id, agent_id, hostname, pid, started_at, last_seen_at, status
      from agent_runtimes
      where hostname = ${agent.hostname}
        and runtime_id <> ${runtime.runtimeId}
        and status = 'active'
        and shutdown_requested_at is null
        and last_seen_at > now() - interval '30 seconds'
      order by last_seen_at desc
    `;
    const activeRuntimes = activeRows.map(mapRuntimeInfo);

    if (activeRuntimes.length && !runtime.takeover) {
      throw new SyncEngineHttpError(409, "agent runtime already active for host", {
        ok: false,
        error: "agent runtime already active for host",
        control: {
          action: "reject",
          reason: "host already has an active agent runtime",
          activeRuntimes,
        },
      });
    }

    if (activeRuntimes.length && runtime.takeover) {
      await tx`
        update agent_runtimes
        set status = 'shutdown',
            shutdown_requested_at = now(),
            shutdown_reason = ${`replaced by ${runtime.runtimeId}`},
            replaced_by_runtime_id = ${runtime.runtimeId},
            updated_at = now()
        where hostname = ${agent.hostname}
          and runtime_id <> ${runtime.runtimeId}
          and status = 'active'
          and shutdown_requested_at is null
      `;
    }

    const currentRows = await tx`
      select shutdown_requested_at, shutdown_reason
      from agent_runtimes
      where runtime_id = ${runtime.runtimeId}
      limit 1
    `;
    const currentShutdown = currentRows[0]?.shutdown_requested_at;
    const currentShutdownReason = currentRows[0]?.shutdown_reason;

    await tx`
      insert into agent_runtimes (
        runtime_id,
        agent_id,
        hostname,
        pid,
        started_at,
        process_started_at,
        last_seen_at,
        status,
        takeover,
        metadata,
        updated_at
      )
      values (
        ${runtime.runtimeId},
        ${agent.agentId},
        ${agent.hostname},
        ${runtime.pid},
        ${runtime.startedAt},
        ${runtime.startedAt},
        now(),
        ${currentShutdown ? "shutdown" : "active"},
        ${runtime.takeover},
        ${runtime.metadata}::jsonb,
        now()
      )
      on conflict (runtime_id) do update set
        agent_id = excluded.agent_id,
        hostname = excluded.hostname,
        pid = coalesce(excluded.pid, agent_runtimes.pid),
        started_at = coalesce(excluded.started_at, agent_runtimes.started_at),
        process_started_at = coalesce(excluded.process_started_at, agent_runtimes.process_started_at),
        last_seen_at = now(),
        takeover = excluded.takeover,
        metadata = agent_runtimes.metadata || excluded.metadata,
        updated_at = now()
    `;

    if (currentShutdown) {
      return {
        action: "shutdown",
        reason: currentShutdownReason ?? "shutdown requested by server",
        activeRuntimes,
      };
    }

    return {
      action: "continue",
      ...(activeRuntimes.length ? { reason: "replaced active runtimes", activeRuntimes } : {}),
    };
  });
}

function mapRuntimeInfo(row: any): AgentRuntimeInfo {
  return {
    runtimeId: row.runtime_id,
    agentId: row.agent_id,
    hostname: row.hostname,
    pid: row.pid == null ? null : Number(row.pid),
    startedAt: row.started_at ?? null,
    lastSeenAt: row.last_seen_at,
    status: row.status,
  };
}

function normalizeInventoryFiles(body: Record<string, unknown>) {
  const files = arrayField(body.files, "files", syncEnginePolicy.requestLimits.filesPerInventory);
  return files.map((file, index) => normalizeSourceFile(file, `files[${index}]`));
}

function normalizeAppendSource(value: unknown, options: { sourceGeneration: number }) {
  return normalizeSourceFile(value, "source", { allowMissingSize: true, sourceGeneration: options.sourceGeneration });
}

function normalizeSourceFile(
  value: unknown,
  label: string,
  options: { allowMissingSize?: boolean; sourceGeneration?: number } = {},
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
    sourceGeneration: options.sourceGeneration ?? generationFromObject(file, label) ?? 1,
    pathSha256: optionalSha256(file.pathSha256) ?? sha256Hex(Buffer.from(sourcePath, "utf8")),
    sizeBytes: optionalNonNegativeInteger(file.sizeBytes, `${label}.sizeBytes`) ?? (options.allowMissingSize ? 0 : requiredNumber(file.sizeBytes, `${label}.sizeBytes`)),
    mtimeMs: optionalNumber(file.mtimeMs, `${label}.mtimeMs`),
    contentSha256: optionalSha256(file.contentSha256),
    mimeType: optionalString(file.mimeType, { max: 255 }),
    encoding: optionalString(file.encoding, { max: 80 }),
    lineCount: optionalNonNegativeInteger(file.lineCount, `${label}.lineCount`),
    rawStorageKey: null,
    rawStorageBytes: null,
    git,
    metadata,
    redaction: {
      ...limitMetadata(redactMetadata(file.redaction), `${label}.redaction`),
      metadataRedacted: true,
    },
    deleted: file.deleted === true,
  };
}

function normalizeAppendChunks(body: Record<string, unknown>, sourceGeneration: number, options: NormalizeAppendOptions = {}) {
  const chunks = arrayField(body.chunks, "chunks", syncEnginePolicy.requestLimits.chunksPerAppend);
  let eventCount = 0;
  return chunks.map((chunk, index) => {
    const normalized = normalizeAppendChunk(chunk, `chunks[${index}]`, sourceGeneration, options);
    eventCount += normalized.events.length;
    if (eventCount > syncEnginePolicy.requestLimits.eventsPerAppend) {
      throw new SyncEngineHttpError(400, "too many append events");
    }
    return normalized;
  });
}

function normalizeAppendChunk(value: unknown, label: string, sourceGeneration: number, options: NormalizeAppendOptions): AppendChunkInput {
  const chunk = assertObject(value, label);
  const chunkGeneration = generationFromObject(chunk, label) ?? sourceGeneration;
  if (chunkGeneration !== sourceGeneration) throw new SyncEngineHttpError(400, `${label}.generation must match source.generation`);
  const raw = readRawChunk(chunk, label, options);
  const events = Array.isArray(chunk.events)
    ? arrayField(chunk.events, `${label}.events`, syncEnginePolicy.requestLimits.eventsPerAppend).map((event, index) =>
        normalizeNormalizedEvent(event, `${label}.events[${index}]`, sourceGeneration),
      )
    : [];
  const chunkId = optionalString(chunk.chunkId, { max: 200 }) ?? raw.rawSha256 ?? sha256Hex(Buffer.from(`${label}:${Date.now()}`));

  return {
    chunkId,
    appendIdentity: appendIdentityKey(sourceGeneration, chunkId),
    sourceGeneration,
    sequence: optionalNonNegativeInteger(chunk.sequence, `${label}.sequence`),
    cursorStart: optionalString(chunk.cursorStart, { max: 200 }),
    cursorEnd: optionalString(chunk.cursorEnd, { max: 200 }),
    rawSha256: raw.rawSha256 ?? optionalSha256(chunk.rawSha256),
    rawBytes: raw.rawBytes ?? optionalNonNegativeInteger(chunk.rawBytes, `${label}.rawBytes`) ?? 0,
    ...("rawPayload" in raw && raw.rawPayload ? { rawPayload: raw.rawPayload } : {}),
    compression: optionalString(chunk.compression, { max: 80 }),
    encoding: optionalString(chunk.encoding, { max: 80 }),
    contentType: optionalString(chunk.contentType, { max: 255 }),
    metadata: limitMetadata({ ...redactMetadata(chunk.metadata), sourceGeneration }, `${label}.metadata`),
    redaction: {
      ...limitMetadata(redactMetadata(chunk.redaction), `${label}.redaction`),
      storedRaw: false,
      rawPolicy: syncEnginePolicy.storage.rawChunks,
      applied: ["raw_not_stored", "metadata_redacted"],
    },
    events,
  };
}

function normalizeNormalizedEvent(value: unknown, label: string, sourceGeneration: number): NormalizedEventInput {
  const event = assertObject(value, label);
  const source = isPlainObject(event.source) ? event.source : {};
  const sourceOffset = optionalNonNegativeInteger(event.sourceOffset ?? event.offset ?? source.byteOffset ?? source.offset, `${label}.sourceOffset`);
  const sourceLineNo = optionalNonNegativeInteger(event.sourceLineNo ?? event.lineNo ?? source.lineNo, `${label}.sourceLineNo`);
  const normalized = normalizedEventWithinLimit(event, label, sourceGeneration, sourceLineNo, sourceOffset);
  const contentSha256 = optionalSha256(event.contentSha256 ?? event.sha256) ?? sha256Hex(Buffer.from(JSON.stringify(normalized), "utf8"));
  return {
    eventUid:
      optionalString(event.eventUid, { max: 255 }) ??
      optionalString(event.id, { max: 255 }) ??
      stableEventUid(`g${sourceGeneration}:${label}`, sourceLineNo, sourceOffset, contentSha256),
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

function normalizedEventWithinLimit(
  event: Record<string, unknown>,
  label: string,
  sourceGeneration: number,
  sourceLineNo: number | null,
  sourceOffset: number | null,
) {
  const normalized = safeNormalizedEvent(event);
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes <= syncEnginePolicy.requestLimits.normalizedEventBytes) return normalized;

  const source = isPlainObject(normalized.source) ? normalized.source : isPlainObject(event.source) ? event.source : undefined;
  const safeSource: Record<string, unknown> = {};
  if (source) copyAllowed(safeSource, source, ["provider", "sourcePath", "lineNo", "byteOffset", "rawType", "rawKind"]);
  if (sourceLineNo != null) safeSource.lineNo = sourceLineNo;
  if (sourceOffset != null) safeSource.byteOffset = sourceOffset;

  return limitMetadata(
    {
      kind: "error",
      role: "system",
      display: false,
      parts: [
        {
          kind: "event",
          name: "normalized_too_large",
          data: {
            reason: "normalized_too_large",
            message: `Normalized event exceeds ${syncEnginePolicy.requestLimits.normalizedEventBytes} bytes and was compacted`,
            normalizedBytes: bytes,
            maxBytes: syncEnginePolicy.requestLimits.normalizedEventBytes,
            normalizedSha256: sha256Hex(Buffer.from(JSON.stringify(normalized), "utf8")),
            sourceGeneration,
          },
        },
      ],
      ...(Object.keys(safeSource).length ? { source: redactMetadata(safeSource) } : {}),
    },
    `${label}.normalized.compacted`,
    syncEnginePolicy.requestLimits.normalizedEventBytes,
  );
}

function readRawChunk(chunk: Record<string, unknown>, label: string, options: NormalizeAppendOptions) {
  if (typeof chunk.rawText === "string") {
    const bytes = Buffer.from(chunk.rawText, "utf8");
    assertRawChunkSize(bytes.length, label);
    return {
      rawSha256: sha256Hex(bytes),
      rawBytes: bytes.length,
      ...(options.includeRawPayload ? { rawPayload: new Uint8Array(bytes) } : {}),
    };
  }

  if (typeof chunk.rawBase64 === "string") {
    const compact = chunk.rawBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new SyncEngineHttpError(400, `${label}.rawBase64 is invalid`);
    const bytes = Buffer.from(compact, "base64");
    assertRawChunkSize(bytes.length, label);
    return {
      rawSha256: sha256Hex(bytes),
      rawBytes: bytes.length,
      ...(options.includeRawPayload ? { rawPayload: new Uint8Array(bytes) } : {}),
    };
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

function appendSourceGeneration(body: Record<string, unknown>, sourceValue: unknown) {
  const source = isPlainObject(sourceValue) ? sourceValue : {};
  const cursor = isPlainObject(body.cursor) ? body.cursor : {};
  const cursorMetadata = isPlainObject(cursor.metadata) ? cursor.metadata : {};
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];

  const candidates: Array<[unknown, string]> = [
    [source.generation, "source.generation"],
    [source.sourceGeneration, "source.sourceGeneration"],
    [source.fileGeneration, "source.fileGeneration"],
    [body.generation, "generation"],
    [body.sourceGeneration, "sourceGeneration"],
    [body.fileGeneration, "fileGeneration"],
    [generationFromCursorString(cursor.value), "cursor.value"],
    [cursor.generation, "cursor.generation"],
    [cursor.sourceGeneration, "cursor.sourceGeneration"],
    [cursorMetadata.generation, "cursor.metadata.generation"],
    [cursorMetadata.sourceGeneration, "cursor.metadata.sourceGeneration"],
  ];

  for (const [chunk, index] of chunks.entries()) {
    if (!isPlainObject(chunk)) continue;
    candidates.push([chunk.generation, `chunks[${index}].generation`]);
    candidates.push([chunk.sourceGeneration, `chunks[${index}].sourceGeneration`]);
    candidates.push([generationFromCursorString(chunk.cursorStart), `chunks[${index}].cursorStart`]);
    candidates.push([generationFromCursorString(chunk.cursorEnd), `chunks[${index}].cursorEnd`]);
  }

  let generation: number | null = null;
  for (const [value, label] of candidates) {
    const next = optionalPositiveInteger(value, label);
    if (next == null) continue;
    if (generation != null && generation !== next) throw new SyncEngineHttpError(400, "append generation fields must agree");
    generation = next;
  }
  return generation ?? 1;
}

function generationFromCursorString(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(\d+):/.exec(value.trim());
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function generationFromObject(value: Record<string, unknown>, label: string) {
  return (
    optionalPositiveInteger(value.generation, `${label}.generation`) ??
    optionalPositiveInteger(value.sourceGeneration, `${label}.sourceGeneration`) ??
    optionalPositiveInteger(value.fileGeneration, `${label}.fileGeneration`)
  );
}

function appendCursorMetadata(
  metadata: Record<string, unknown>,
  sourceGeneration: number,
  lastChunk: Pick<AppendChunkInput, "appendIdentity" | "chunkId" | "cursorEnd" | "sourceGeneration"> | undefined,
  ackCursor: string,
) {
  return limitMetadata(
    {
      ...metadata,
      generation: sourceGeneration,
      sourceGeneration,
      ackCursor,
      lastChunkId: lastChunk?.chunkId,
      lastAppendIdentity: lastChunk?.appendIdentity,
    },
    "cursor.metadata",
  );
}

function buildStoragePolicy(env: Record<string, string | undefined> = process.env) {
  const mode = rawSyncStorageMode(env);
  return {
    ...syncEnginePolicy.storage,
    rawChunks: mode === "filesystem" && rawSyncDataDir(env) ? "filesystem" : syncEnginePolicy.storage.rawChunks,
    rawFilesStoredByDefault: false,
  };
}

async function storeRawChunkPayload(
  input: {
    agentId: string;
    sourceFileId: unknown;
    sourceGeneration: number;
    chunkId: string;
    rawSha256: string | null;
    rawBytes: number;
    rawPayload?: Uint8Array;
  },
  env: Record<string, string | undefined> = process.env,
) {
  const plan = planRawChunkStorage({ ...input, hasRawPayload: input.rawPayload != null }, env);
  if (plan.kind !== "filesystem" || !plan.storageKey || !input.rawPayload) return plan;

  const dataDir = rawSyncDataDir(env);
  if (!dataDir) return hashOnlyRawStoragePlan("data_dir_not_configured");

  const path = rawStorageDataPath(dataDir, plan.storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(input.rawPayload));
  return plan;
}

function rawStorageRedaction(redaction: Record<string, unknown>, storage: RawChunkStoragePlan) {
  return {
    ...redaction,
    storedRaw: storage.storedRaw,
    rawPolicy: storage.kind,
    rawStorageKey: storage.storageKey,
    rawStorageReason: storage.reason,
    applied: storage.storedRaw ? ["filesystem_raw_storage", "metadata_redacted"] : ["raw_not_stored", "metadata_redacted"],
  };
}

function rawSyncStorageMode(env: Record<string, string | undefined>) {
  const value = envValue(env, "SYNC_RAW_STORAGE")?.toLowerCase();
  return value === "filesystem" ? "filesystem" : "hash_only";
}

function rawSyncDataDir(env: Record<string, string | undefined>) {
  return envValue(env, "DATA_DIR", "CHATVIEW_DATA_DIR");
}

function hashOnlyRawStoragePlan(reason: string): RawChunkStoragePlan {
  return {
    kind: "hash_only",
    storageKey: null,
    storedRaw: false,
    rawBody: null,
    rawText: null,
    reason,
  };
}

function rawChunkStorageKey(input: {
  agentId: string;
  sourceFileId: unknown;
  sourceGeneration: number;
  chunkId: string;
  rawSha256: string | null;
}) {
  const sha = input.rawSha256 ?? "unknown";
  return [
    "filesystem",
    "sync",
    "raw-chunks",
    safePathPart(input.agentId),
    safePathPart(String(input.sourceFileId)),
    `g${input.sourceGeneration}`,
    sha.slice(0, 2),
    `${safePathPart(input.chunkId).slice(0, 80)}-${sha}`,
  ].join("/");
}

function rawStorageDataPath(dataDir: string, storageKey: string) {
  const normalized = normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error("invalid raw storage key");
  return join(dataDir, normalized);
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-") || "unknown";
}

async function upsertAgent(sql: any, agent: SyncAgent) {
  await sql`
    insert into agents (id, hostname, platform, arch, version, source_root, metadata_revision, last_seen_at)
    values (
      ${agent.agentId},
      ${agent.hostname},
      ${agent.platform},
      ${agent.arch},
      ${agent.version},
      ${agent.sourceRoot},
      nextval('sync_metadata_revision_seq'),
      now()
    )
    on conflict (id) do update set
      hostname = excluded.hostname,
      platform = coalesce(excluded.platform, agents.platform),
      arch = coalesce(excluded.arch, agents.arch),
      version = coalesce(excluded.version, agents.version),
      source_root = coalesce(excluded.source_root, agents.source_root),
      metadata_revision = case
        when agents.hostname is distinct from excluded.hostname
          or agents.platform is distinct from coalesce(excluded.platform, agents.platform)
          or agents.arch is distinct from coalesce(excluded.arch, agents.arch)
          or agents.version is distinct from coalesce(excluded.version, agents.version)
          or agents.source_root is distinct from coalesce(excluded.source_root, agents.source_root)
        then nextval('sync_metadata_revision_seq')
        else agents.metadata_revision
      end,
      last_seen_at = now()
  `;
}

async function upsertSourceFile(sql: any, agentId: string, file: SourceFileInput) {
  return await sql`
    insert into agent_source_files (
      agent_id,
      provider,
      source_kind,
      current_generation,
      source_path,
      path_sha256,
      size_bytes,
      mtime_ms,
      content_sha256,
      mime_type,
      encoding,
      line_count,
      raw_storage_key,
      raw_storage_bytes,
      git,
      metadata,
      redaction,
      metadata_revision,
      deleted_at,
      last_seen_at
    )
    values (
      ${agentId},
      ${file.provider},
      ${file.sourceKind},
      ${file.sourceGeneration},
      ${file.sourcePath},
      ${file.pathSha256},
      ${file.sizeBytes},
      ${file.mtimeMs},
      ${file.contentSha256},
      ${file.mimeType},
      ${file.encoding},
      ${file.lineCount},
      ${file.rawStorageKey},
      ${file.rawStorageBytes},
      ${file.git}::jsonb,
      ${file.metadata}::jsonb,
      ${file.redaction}::jsonb,
      nextval('sync_metadata_revision_seq'),
      case when ${file.deleted}::boolean then now() else null end,
      now()
    )
    on conflict (agent_id, path_sha256) do update set
      provider = excluded.provider,
      source_kind = excluded.source_kind,
      current_generation = greatest(agent_source_files.current_generation, excluded.current_generation),
      source_path = excluded.source_path,
      size_bytes = excluded.size_bytes,
      mtime_ms = coalesce(excluded.mtime_ms, agent_source_files.mtime_ms),
      content_sha256 = coalesce(excluded.content_sha256, agent_source_files.content_sha256),
      mime_type = coalesce(excluded.mime_type, agent_source_files.mime_type),
      encoding = coalesce(excluded.encoding, agent_source_files.encoding),
      line_count = coalesce(excluded.line_count, agent_source_files.line_count),
      raw_storage_key = coalesce(excluded.raw_storage_key, agent_source_files.raw_storage_key),
      raw_storage_bytes = coalesce(excluded.raw_storage_bytes, agent_source_files.raw_storage_bytes),
      git = agent_source_files.git || excluded.git,
      metadata = agent_source_files.metadata || excluded.metadata,
      redaction = agent_source_files.redaction || excluded.redaction,
      metadata_revision = nextval('sync_metadata_revision_seq'),
      deleted_at = case
        when excluded.deleted_at is not null then excluded.deleted_at
        when agent_source_files.deleted_at is null then null
        when excluded.current_generation > agent_source_files.current_generation then null
        else agent_source_files.deleted_at
      end,
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
  sourceGeneration: number,
) {
  const sourceFileIdKey = sourceFileId ?? 0;
  await sql`
    insert into agent_sync_cursors (agent_id, source_file_id, source_file_id_key, source_generation, cursor_scope, cursor_value, metadata, updated_at)
    values (${agentId}, ${sourceFileId}, ${sourceFileIdKey}, ${sourceGeneration}, ${scope}, ${value}, ${metadata}::jsonb, now())
    on conflict (agent_id, cursor_scope, source_file_id_key) do update set
      source_generation = excluded.source_generation,
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
  const trimmed = sanitizePostgresString(value).trim();
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

function optionalProcessPid(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new SyncEngineHttpError(400, `${label} must be a positive integer`);
}

function optionalPositiveInteger(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) throw new SyncEngineHttpError(400, `${label} must be a positive integer`);
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    throw new SyncEngineHttpError(400, `${label} must be a positive integer`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SyncEngineHttpError(400, `${label} must be a positive integer`);
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
    return sanitizePostgresString(value).replace(bearerPattern, "Bearer <redacted>").replace(longSecretPattern, "<redacted>");
  }

  if (Array.isArray(value)) return value.slice(0, 200).map((item, index) => redactValue(item, `${path}[${index}]`, seen));

  if (!isPlainObject(value)) return value ?? {};
  if (seen.has(value)) return "<circular>";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    const keyWithoutNul = sanitizePostgresString(key);
    const safeKey = sensitiveKeyPattern.test(keyWithoutNul)
      ? `redacted_key_${sha256Hex(Buffer.from(keyWithoutNul, "utf8")).slice(0, 12)}`
      : keyWithoutNul;
    if (sensitiveKeyPattern.test(keyWithoutNul)) {
      output[safeKey] = "<redacted>";
    } else {
      output[safeKey] = redactValue(child, `${path}.${keyWithoutNul}`, seen);
    }
  }
  seen.delete(value);
  return output;
}

function sanitizePostgresString(value: string) {
  return sanitizePostgresText(value);
}

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
