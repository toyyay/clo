import type { HostInfo, SessionEvent, SessionInfo, SessionPayload } from "../../packages/shared/types";

export const V2_SESSION_ID_PREFIX = "v2:";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

type V2SessionRow = {
  id: unknown;
  agent_id: string;
  hostname: string;
  provider?: unknown;
  source_kind?: unknown;
  current_generation?: unknown;
  source_path?: unknown;
  size_bytes?: unknown;
  mtime_ms?: unknown;
  content_sha256?: unknown;
  mime_type?: unknown;
  encoding?: unknown;
  line_count?: unknown;
  git?: unknown;
  metadata?: unknown;
  first_seen_at?: unknown;
  last_seen_at?: unknown;
  deleted_at?: unknown;
  event_count?: unknown;
};

type V2EventRow = {
  id: unknown;
  source_file_id: unknown;
  source_line_no?: unknown;
  source_offset?: unknown;
  event_type?: unknown;
  role?: unknown;
  occurred_at?: unknown;
  created_at?: unknown;
  normalized?: unknown;
  ordinal?: unknown;
};

export function v2SessionId(sourceFileId: unknown) {
  return `${V2_SESSION_ID_PREFIX}${toId(sourceFileId)}`;
}

export function parseV2SessionId(id: string) {
  if (!id.startsWith(V2_SESSION_ID_PREFIX)) return null;
  const sourceFileId = id.slice(V2_SESSION_ID_PREFIX.length);
  return /^\d+$/.test(sourceFileId) ? sourceFileId : null;
}

export function isV2SessionId(id: string) {
  return parseV2SessionId(id) !== null;
}

export async function listV2Hosts(sql: SqlTag): Promise<HostInfo[]> {
  const rows = await sql`
    select
      a.id,
      a.hostname,
      a.platform,
      a.arch,
      a.version,
      a.source_root,
      a.created_at,
      a.last_seen_at,
      count(distinct f.id) filter (where f.deleted_at is null and f.source_kind = 'conversation') as session_count,
      count(e.id) filter (where f.deleted_at is null and f.source_kind = 'conversation') as event_count
    from agents a
    left join agent_source_files f on f.agent_id = a.id
    left join agent_normalized_events e
      on e.source_file_id = f.id
      and e.source_generation = f.current_generation
    group by a.id
    having count(distinct f.id) filter (where f.deleted_at is null and f.source_kind = 'conversation') > 0
    order by a.last_seen_at desc
  `;

  return rows.map(mapV2HostRow);
}

export async function listV2Sessions(sql: SqlTag, agentId?: string): Promise<SessionInfo[]> {
  const rows = agentId
    ? await sql`
        select
          f.id,
          f.agent_id,
          a.hostname,
          f.provider,
          f.source_kind,
          f.current_generation,
          f.source_path,
          f.size_bytes,
          f.mtime_ms,
          f.content_sha256,
          f.mime_type,
          f.encoding,
          f.line_count,
          f.git,
          f.metadata,
          f.first_seen_at,
          f.last_seen_at,
          f.deleted_at,
          count(e.id) as event_count
        from agent_source_files f
        join agents a on a.id = f.agent_id
        left join agent_normalized_events e
          on e.source_file_id = f.id
          and e.source_generation = f.current_generation
        where f.agent_id = ${agentId}
          and f.source_kind = 'conversation'
          and f.deleted_at is null
        group by f.id, a.hostname
        order by f.last_seen_at desc, max(e.id) desc nulls last
      `
    : await sql`
        select
          f.id,
          f.agent_id,
          a.hostname,
          f.provider,
          f.source_kind,
          f.current_generation,
          f.source_path,
          f.size_bytes,
          f.mtime_ms,
          f.content_sha256,
          f.mime_type,
          f.encoding,
          f.line_count,
          f.git,
          f.metadata,
          f.first_seen_at,
          f.last_seen_at,
          f.deleted_at,
          count(e.id) as event_count
        from agent_source_files f
        join agents a on a.id = f.agent_id
        left join agent_normalized_events e
          on e.source_file_id = f.id
          and e.source_generation = f.current_generation
        where f.source_kind = 'conversation'
          and f.deleted_at is null
        group by f.id, a.hostname
        order by f.last_seen_at desc, max(e.id) desc nulls last
      `;

  return rows.map(mapV2SessionRow);
}

export async function getV2SessionsMeta(sql: SqlTag, sourceFileIds: string[], options: { includeDeleted?: boolean } = {}): Promise<SessionInfo[]> {
  const ids = [...new Set(sourceFileIds.filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) return [];
  const rows = options.includeDeleted
    ? await sql`
        select
          f.id,
          f.agent_id,
          a.hostname,
          f.provider,
          f.source_kind,
          f.current_generation,
          f.source_path,
          f.size_bytes,
          f.mtime_ms,
          f.content_sha256,
          f.mime_type,
          f.encoding,
          f.line_count,
          f.git,
          f.metadata,
          f.first_seen_at,
          f.last_seen_at,
          f.deleted_at,
          count(e.id) as event_count
        from agent_source_files f
        join agents a on a.id = f.agent_id
        left join agent_normalized_events e
          on e.source_file_id = f.id
          and e.source_generation = f.current_generation
        where f.id = any(${postgresBigintArrayLiteral(ids)}::bigint[])
          and f.source_kind = 'conversation'
        group by f.id, a.hostname
      `
    : await sql`
        select
          f.id,
          f.agent_id,
          a.hostname,
          f.provider,
          f.source_kind,
          f.current_generation,
          f.source_path,
          f.size_bytes,
          f.mtime_ms,
          f.content_sha256,
          f.mime_type,
          f.encoding,
          f.line_count,
          f.git,
          f.metadata,
          f.first_seen_at,
          f.last_seen_at,
          f.deleted_at,
          count(e.id) as event_count
        from agent_source_files f
        join agents a on a.id = f.agent_id
        left join agent_normalized_events e
          on e.source_file_id = f.id
          and e.source_generation = f.current_generation
        where f.id = any(${postgresBigintArrayLiteral(ids)}::bigint[])
          and f.source_kind = 'conversation'
          and f.deleted_at is null
        group by f.id, a.hostname
      `;
  const byId = new Map(rows.map((row: any) => [toId(row.id), mapV2SessionRow(row)] as const));
  return ids.map((id) => byId.get(id)).filter((session): session is SessionInfo => Boolean(session));
}

export async function getV2Session(sql: SqlTag, sessionId: string): Promise<SessionPayload | null> {
  const sourceFileId = parseV2SessionId(sessionId);
  if (!sourceFileId) return null;

  const sessionRows = await sql`
    select
      f.id,
      f.agent_id,
      a.hostname,
      f.provider,
      f.source_kind,
      f.current_generation,
      f.source_path,
      f.size_bytes,
      f.mtime_ms,
      f.content_sha256,
      f.mime_type,
      f.encoding,
      f.line_count,
      f.git,
      f.metadata,
      f.first_seen_at,
      f.last_seen_at,
      f.deleted_at,
      count(e.id) as event_count
    from agent_source_files f
    join agents a on a.id = f.agent_id
    left join agent_normalized_events e
      on e.source_file_id = f.id
      and e.source_generation = f.current_generation
    where f.id = ${sourceFileId}
      and f.source_kind = 'conversation'
      and f.deleted_at is null
    group by f.id, a.hostname
  `;

  if (!sessionRows.length) return null;

  const eventRows = await sql`
    select
      e.id,
      e.source_file_id,
      e.source_line_no,
      e.source_offset,
      e.event_type,
      e.role,
      e.occurred_at,
      e.created_at,
      e.normalized,
      row_number() over (
        order by e.source_line_no asc nulls last, e.source_offset asc nulls last, e.id asc
      ) as ordinal
    from agent_normalized_events e
    join agent_source_files f on f.id = e.source_file_id
    where e.source_file_id = ${sourceFileId}
      and e.source_generation = f.current_generation
      and f.source_kind = 'conversation'
      and f.deleted_at is null
    order by e.source_line_no asc nulls last, e.source_offset asc nulls last, e.id asc
  `;

  return {
    session: mapV2SessionRow(sessionRows[0]),
    events: eventRows.map(mapV2EventRow),
  };
}

export async function listV2EventsForSync(sql: SqlTag, cursor: bigint, limit: number): Promise<V2EventRow[]> {
  return await sql`
    select
      visible.id,
      visible.source_file_id,
      visible.source_line_no,
      visible.source_offset,
      visible.event_type,
      visible.role,
      visible.occurred_at,
      visible.created_at,
      visible.normalized,
      visible.ordinal
    from (
      select
        e.id,
        e.source_file_id,
        e.source_line_no,
        e.source_offset,
        e.event_type,
        e.role,
        e.occurred_at,
        e.created_at,
        e.normalized,
        row_number() over (
          partition by e.source_file_id
          order by e.source_line_no asc nulls last, e.source_offset asc nulls last, e.id asc
        ) as ordinal
      from agent_normalized_events e
      join agent_source_files f on f.id = e.source_file_id
      where e.source_generation = f.current_generation
        and f.source_kind = 'conversation'
        and f.deleted_at is null
    ) visible
    where visible.id > ${cursor}
    order by visible.id asc
    limit ${limit}
  `;
}

export function mapV2HostRow(row: any): HostInfo {
  return {
    agentId: row.id,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    version: row.version,
    sourceRoot: row.source_root,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    sessionCount: toNumber(row.session_count),
    eventCount: toNumber(row.event_count),
  };
}

export function mapV2SessionRow(row: V2SessionRow): SessionInfo {
  const metadata = jsonRecord(row.metadata);
  const git = jsonRecord(row.git);
  const provider = stringValue(row.provider) ?? "unknown";
  const sourceKind = stringValue(row.source_kind) ?? "conversation";
  const sourceGeneration = row.current_generation == null ? null : toNumber(row.current_generation);
  const sourcePath = stringValue(row.source_path) ?? "";
  const projectKey = inferProjectKey(provider, sourcePath, metadata);

  return {
    id: v2SessionId(row.id),
    agentId: row.agent_id,
    hostname: row.hostname,
    sourceProvider: provider,
    sourceKind,
    sourceGeneration,
    sourceId: toId(row.id),
    projectKey,
    projectName: stringValue(metadata.projectName) ?? stringValue(metadata.displayName) ?? defaultProjectName(provider, projectKey),
    sessionId: stringValue(metadata.sessionId) ?? stringValue(metadata.chatId) ?? inferSessionId(sourcePath),
    title: stringValue(metadata.title) ?? null,
    sourcePath,
    sizeBytes: toNumber(row.size_bytes),
    mtimeMs: row.mtime_ms == null ? 0 : toNumber(row.mtime_ms),
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    eventCount: toNumber(row.event_count),
    contentSha256: stringValue(row.content_sha256) ?? null,
    mimeType: stringValue(row.mime_type) ?? null,
    encoding: stringValue(row.encoding) ?? null,
    lineCount: row.line_count == null ? null : toNumber(row.line_count),
    mode: null,
    symlinkTarget: null,
    gitRepoRoot: stringValue(git.repoRoot) ?? stringValue(git.repo_root) ?? null,
    gitBranch: stringValue(git.branch) ?? null,
    gitCommit: stringValue(git.commit) ?? null,
    gitDirty: booleanValue(git.dirty),
    gitRemoteUrl: stringValue(git.remoteUrl) ?? stringValue(git.remote_url) ?? null,
    deletedAt: (row.deleted_at as string | null | undefined) ?? null,
  };
}

export function mapV2EventRow(row: V2EventRow): SessionEvent {
  const normalized = parseJsonMaybe(row.normalized);
  const createdAt = row.occurred_at ?? timestampFromNormalized(normalized);
  const lineNo = row.source_line_no == null ? Math.max(0, toNumber(row.ordinal) - 1) : toNumber(row.source_line_no);

  return {
    id: v2EventId(row.id),
    sessionDbId: v2SessionId(row.source_file_id),
    lineNo,
    offset: row.source_offset == null ? 0 : toNumber(row.source_offset),
    eventType: stringValue(row.event_type) ?? eventKindFromNormalized(normalized),
    role: stringValue(row.role) ?? eventRoleFromNormalized(normalized),
    createdAt: (createdAt as string | null | undefined) ?? null,
    ingestedAt: row.created_at as string,
    raw: normalizedEventToLegacyRaw(normalized, {
      eventType: row.event_type,
      role: row.role,
      occurredAt: createdAt,
    }),
  };
}

export function mergeHostLists(legacyHosts: HostInfo[], v2Hosts: HostInfo[]): HostInfo[] {
  const byAgent = new Map<string, HostInfo>();
  for (const host of [...legacyHosts, ...v2Hosts]) {
    const existing = byAgent.get(host.agentId);
    if (!existing) {
      byAgent.set(host.agentId, { ...host });
      continue;
    }

    existing.hostname = host.hostname || existing.hostname;
    existing.platform = existing.platform ?? host.platform;
    existing.arch = existing.arch ?? host.arch;
    existing.version = existing.version ?? host.version;
    existing.sourceRoot = existing.sourceRoot ?? host.sourceRoot;
    existing.createdAt = earlierTimestamp(existing.createdAt, host.createdAt);
    existing.lastSeenAt = laterTimestamp(existing.lastSeenAt, host.lastSeenAt);
    existing.sessionCount += host.sessionCount;
    existing.eventCount += host.eventCount;
  }
  return [...byAgent.values()].sort((a, b) => compareTimestampDesc(a.lastSeenAt, b.lastSeenAt));
}

export function mergeSessionLists(legacySessions: SessionInfo[], v2Sessions: SessionInfo[]): SessionInfo[] {
  return [...v2Sessions, ...legacySessions].sort((a, b) => compareTimestampDesc(a.lastSeenAt, b.lastSeenAt));
}

export function normalizedEventToLegacyRaw(
  normalizedInput: unknown,
  fallback: { eventType?: unknown; role?: unknown; occurredAt?: unknown } = {},
): unknown {
  const normalized = jsonRecord(normalizedInput);
  if (isLegacyRenderableRaw(normalized)) return normalized;

  const parts = legacyContentParts(normalized.parts);
  const role = displayRole(normalized, fallback);
  if (!role || normalized.display === false || !parts.length) {
    return {
      type: stringValue(fallback.eventType) ?? eventKindFromNormalized(normalizedInput) ?? "event",
      normalized,
    };
  }

  const timestamp = stringValue(normalized.timestamp) ?? stringValue(normalized.occurredAt) ?? stringValue(fallback.occurredAt);
  return {
    type: role,
    message: {
      role,
      content: parts,
    },
    timestamp,
    normalized,
  };
}

function v2EventId(eventId: unknown) {
  return `v2e:${toId(eventId)}`;
}

function postgresBigintArrayLiteral(values: string[]) {
  return `{${values.join(",")}}`;
}

function inferProjectKey(provider: string, sourcePath: string, metadata: Record<string, unknown>) {
  const metadataKey = stringValue(metadata.projectKey) ?? stringValue(metadata.project);
  if (metadataKey) return metadataKey;

  const cleanPath = stripProviderPrefix(sourcePath, provider);
  const parts = cleanPath.split(/[\\/]/).filter(Boolean);
  if (provider === "claude" && parts.length > 1) return parts[0];
  return provider || "unknown";
}

function defaultProjectName(provider: string, projectKey: string) {
  if (provider && projectKey === provider) return titleCase(provider);
  return shortProject(projectKey);
}

function inferSessionId(sourcePath: string) {
  const base = stripProviderPrefix(sourcePath).split(/[\\/]/).filter(Boolean).pop() ?? sourcePath;
  return base.replace(/\.jsonl$/i, "") || sourcePath || "unknown";
}

function stripProviderPrefix(sourcePath: string, provider?: string) {
  const expectedPrefix = provider ? `${provider}:` : "";
  if (expectedPrefix && sourcePath.startsWith(expectedPrefix)) return sourcePath.slice(expectedPrefix.length);
  return sourcePath.replace(/^[a-z][a-z0-9_-]{0,79}:/i, "");
}

function legacyContentParts(value: unknown): any[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => legacyContentPart(part));
}

function legacyContentPart(value: unknown): any[] {
  const part = jsonRecord(value);
  const kind = (stringValue(part.kind) ?? stringValue(part.type) ?? "").toLowerCase();
  if (kind === "text" || kind === "input_text" || kind === "output_text" || kind === "summary_text") {
    const text = stringValue(part.text);
    return text?.trim() ? [{ type: "text", text }] : [];
  }
  if (kind === "thinking" || kind === "reasoning" || kind === "reasoning_text") {
    const thinking = stringValue(part.thinking) ?? stringValue(part.text) ?? stringValue(part.content);
    return thinking?.trim() ? [{ type: "thinking", thinking }] : [];
  }
  if (kind === "tool_call" || kind === "tool_use" || kind === "function_call" || kind === "server_tool_use") {
    return [
      {
        type: "tool_use",
        id: stringValue(part.id) ?? stringValue(part.tool_use_id) ?? stringValue(part.call_id),
        name: stringValue(part.name) ?? stringValue(part.tool_name) ?? "tool",
        input: part.input ?? part.arguments ?? part.parameters ?? {},
      },
    ];
  }
  if (kind === "tool_result" || kind === "function_call_output" || kind === "tool_output") {
    return [
      {
        type: "tool_result",
        tool_use_id: stringValue(part.id) ?? stringValue(part.tool_use_id) ?? stringValue(part.call_id),
        content: part.content ?? part.output ?? part.result ?? "",
        is_error: booleanValue(part.isError) ?? booleanValue(part.is_error) ?? false,
      },
    ];
  }
  return [];
}

function displayRole(normalized: Record<string, unknown>, fallback: { eventType?: unknown; role?: unknown }) {
  const role = (stringValue(normalized.role) ?? stringValue(fallback.role) ?? "").toLowerCase();
  const kind = (stringValue(normalized.kind) ?? stringValue(normalized.eventType) ?? stringValue(normalized.type) ?? stringValue(fallback.eventType) ?? "")
    .toLowerCase();
  if (role === "assistant" || kind === "thinking" || kind === "tool_call") return "assistant";
  if (role === "user" || role === "tool" || kind === "tool_result") return "user";
  return null;
}

function isLegacyRenderableRaw(value: Record<string, unknown>) {
  return (value.type === "user" || value.type === "assistant") && typeof value.message === "object" && value.message !== null;
}

function timestampFromNormalized(value: unknown) {
  const record = jsonRecord(value);
  return stringValue(record.timestamp) ?? stringValue(record.occurredAt) ?? null;
}

function eventKindFromNormalized(value: unknown) {
  const record = jsonRecord(value);
  return stringValue(record.kind) ?? stringValue(record.eventType) ?? stringValue(record.type) ?? null;
}

function eventRoleFromNormalized(value: unknown) {
  const record = jsonRecord(value);
  return stringValue(record.role) ?? null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonMaybe(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseJsonMaybe(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toId(value: unknown) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function toNumber(value: unknown) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value ?? 0);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function titleCase(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function shortProject(raw: string) {
  return raw.replace(/^-Users-[^-]+-/, "").replace(/^p-?/, (match) => (match === "p" ? "p" : "")) || raw;
}

function earlierTimestamp(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterTimestamp(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function compareTimestampDesc(left: string, right: string) {
  return Date.parse(right) - Date.parse(left);
}
