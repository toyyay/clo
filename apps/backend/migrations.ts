import { createHash } from "node:crypto";
import { envFlag } from "../../packages/shared/env";

type Migration = {
  id: string;
  name: string;
  sql: string;
  transaction?: boolean;
};

const MIGRATION_LOCK_NAMESPACE = 3737;
const MIGRATION_LOCK_KEY = 1;

const migrations: Migration[] = [
  {
    id: "0001",
    name: "initial_schema",
    sql: `
create table if not exists agents (
  id text primary key,
  hostname text not null,
  platform text,
  arch text,
  version text,
  source_root text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists projects (
  id bigserial primary key,
  agent_id text not null references agents(id) on delete cascade,
  project_key text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (agent_id, project_key)
);

create table if not exists chat_sessions (
  id bigserial primary key,
  agent_id text not null references agents(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  session_id text not null,
  source_path text not null,
  title text,
  size_bytes bigint not null default 0,
  mtime_ms double precision not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (agent_id, session_id)
);

create table if not exists session_events (
  id bigserial primary key,
  session_db_id bigint not null references chat_sessions(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  source_line_no integer not null,
  source_offset bigint not null,
  event_type text,
  role text,
  occurred_at timestamptz,
  raw jsonb not null,
  ingested_at timestamptz not null default now(),
  unique (session_db_id, source_line_no)
);

create index if not exists idx_sessions_agent_seen
  on chat_sessions (agent_id, last_seen_at desc);

create index if not exists idx_sessions_project_seen
  on chat_sessions (project_id, last_seen_at desc);

create index if not exists idx_events_session_line
  on session_events (session_db_id, source_line_no asc);

create index if not exists idx_events_type
  on session_events (event_type);

create table if not exists yjs_documents (
  doc_id text primary key,
  session_db_id bigint references chat_sessions(id) on delete set null,
  update bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_yjs_documents_session
  on yjs_documents (session_db_id);

create table if not exists shortcut_ingest_tokens (
  id bigserial primary key,
  token text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

insert into shortcut_ingest_tokens (token, label)
values ('iphone-shortcut-dev-token', 'iPhone Shortcut development token')
on conflict (token) do nothing;

create table if not exists shortcut_ingest_requests (
  id bigserial primary key,
  token_id bigint references shortcut_ingest_tokens(id) on delete set null,
  token text,
  method text not null,
  url text not null,
  path text not null,
  query jsonb not null,
  request_headers jsonb not null,
  request_content_type text,
  request_body bytea not null,
  request_body_sha256 text not null,
  request_body_bytes bigint not null,
  response_status integer,
  response_headers jsonb,
  response_body bytea,
  response_body_sha256 text,
  response_body_bytes bigint,
  error text,
  received_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists idx_shortcut_ingest_requests_received
  on shortcut_ingest_requests (received_at desc);

create index if not exists idx_shortcut_ingest_requests_token
  on shortcut_ingest_requests (token_id, received_at desc);

create table if not exists shortcut_audio_blobs (
  id bigserial primary key,
  sha256 text not null unique,
  bytes bytea not null,
  size_bytes bigint not null,
  content_type text,
  filename text,
  extension text,
  detected_format text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_shortcut_audio_blobs_seen
  on shortcut_audio_blobs (last_seen_at desc);

create table if not exists shortcut_ingest_request_audio (
  id bigserial primary key,
  request_id bigint not null references shortcut_ingest_requests(id) on delete cascade,
  audio_id bigint not null references shortcut_audio_blobs(id) on delete cascade,
  part_index integer not null,
  part_name text,
  source_kind text not null,
  filename text,
  content_type text,
  size_bytes bigint not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (request_id, part_index)
);

create index if not exists idx_shortcut_ingest_request_audio_request
  on shortcut_ingest_request_audio (request_id, part_index);
`.trim(),
  },
  {
    id: "0002",
    name: "rename_shortcut_import_tables",
    sql: `
delete from shortcut_ingest_tokens
where token = 'iphone-shortcut-dev-token';

alter table shortcut_ingest_tokens
  rename to import_tokens;

alter table shortcut_ingest_requests
  rename to import_requests;

alter table import_requests
  rename column token to token_sha256;

update import_requests
set token_sha256 = null
where token_sha256 is not null;

alter table shortcut_audio_blobs
  rename to import_media_blobs;

alter table import_media_blobs
  add column if not exists media_kind text not null default 'audio';

alter table shortcut_ingest_request_audio
  rename to import_request_media;

alter table import_request_media
  rename column audio_id to media_id;

alter index if exists idx_shortcut_ingest_requests_received
  rename to idx_import_requests_received;

alter index if exists idx_shortcut_ingest_requests_token
  rename to idx_import_requests_token;

alter index if exists idx_shortcut_audio_blobs_seen
  rename to idx_import_media_blobs_seen;

alter index if exists idx_shortcut_ingest_request_audio_request
  rename to idx_import_request_media_request;
`.trim(),
  },
  {
    id: "0003",
    name: "session_file_and_git_metadata",
    sql: `
alter table chat_sessions
  add column if not exists content_sha256 text,
  add column if not exists mime_type text,
  add column if not exists encoding text,
  add column if not exists line_count integer,
  add column if not exists mode integer,
  add column if not exists symlink_target text,
  add column if not exists git_repo_root text,
  add column if not exists git_branch text,
  add column if not exists git_commit text,
  add column if not exists git_dirty boolean,
  add column if not exists git_remote_url text,
  add column if not exists deleted_at timestamptz;

alter table session_events
  add column if not exists line_sha256 text;

create index if not exists idx_sessions_deleted_at
  on chat_sessions (deleted_at) where deleted_at is not null;

create index if not exists idx_sessions_git_commit
  on chat_sessions (git_commit) where git_commit is not null;

create index if not exists idx_events_line_sha256
  on session_events (line_sha256) where line_sha256 is not null;
`.trim(),
  },
  {
    id: "0004",
    name: "media_transcriptions",
    sql: `
create table if not exists import_media_transcriptions (
  id bigserial primary key,
  media_id bigint not null references import_media_blobs(id) on delete cascade,
  source text not null default 'auto',
  status text not null default 'queued',
  model text not null,
  reasoning_effort text not null default 'medium',
  source_format text,
  mp3_sha256 text,
  mp3_bytes bigint,
  detected_language text,
  transcript jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_import_media_transcriptions_media
  on import_media_transcriptions (media_id, created_at desc);

create index if not exists idx_import_media_transcriptions_status
  on import_media_transcriptions (status, created_at asc);

create table if not exists openrouter_call_logs (
  id bigserial primary key,
  media_id bigint references import_media_blobs(id) on delete set null,
  transcription_id bigint references import_media_transcriptions(id) on delete set null,
  model text,
  endpoint text not null,
  request_json jsonb not null,
  response_status integer,
  response_json jsonb,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_openrouter_call_logs_media
  on openrouter_call_logs (media_id, created_at desc);

create index if not exists idx_openrouter_call_logs_transcription
  on openrouter_call_logs (transcription_id, created_at desc);
`.trim(),
  },
  {
    id: "0005",
    name: "import_request_parts",
    sql: `
create table if not exists import_request_parts (
  id bigserial primary key,
  request_id bigint not null references import_requests(id) on delete cascade,
  part_index integer not null,
  part_name text,
  source_kind text not null,
  filename text,
  content_type text,
  size_bytes bigint not null,
  value_sha256 text,
  value_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_import_request_parts_request
  on import_request_parts (request_id, part_index);
	`.trim(),
  },
  {
    id: "0006",
    name: "app_logs",
    sql: `
create table if not exists app_logs (
  id bigserial primary key,
  source text not null,
  level text not null,
  event text not null,
  message text,
  tags text[] not null default '{}'::text[],
  context jsonb not null default '{}'::jsonb,
  client jsonb not null default '{}'::jsonb,
  request jsonb not null default '{}'::jsonb,
  url text,
  user_agent text,
  client_log_id text,
  client_created_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_logs_created
  on app_logs (created_at desc);

create index if not exists idx_app_logs_source_level
  on app_logs (source, level, created_at desc);

create index if not exists idx_app_logs_event
  on app_logs (event, created_at desc);

create index if not exists idx_app_logs_tags
  on app_logs using gin (tags);
`.trim(),
  },
  {
    id: "0007",
    name: "agent_v1_sync_engine",
    sql: `
create table if not exists agent_source_files (
  id bigserial primary key,
  agent_id text not null references agents(id) on delete cascade,
  provider text not null default 'unknown',
  source_kind text not null default 'conversation',
  source_path text not null,
  path_sha256 text not null,
  size_bytes bigint not null default 0,
  mtime_ms double precision,
  content_sha256 text,
  mime_type text,
  encoding text,
  line_count integer,
  git jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  redaction jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (agent_id, path_sha256)
);

create index if not exists idx_agent_source_files_agent_seen
  on agent_source_files (agent_id, last_seen_at desc);

create index if not exists idx_agent_source_files_provider
  on agent_source_files (provider, source_kind);

create index if not exists idx_agent_source_files_content_sha
  on agent_source_files (content_sha256) where content_sha256 is not null;

create table if not exists agent_sync_cursors (
  id bigserial primary key,
  agent_id text not null references agents(id) on delete cascade,
  source_file_id bigint references agent_source_files(id) on delete cascade,
  source_file_id_key bigint not null default 0,
  cursor_scope text not null default 'global',
  cursor_value text not null default '0',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, cursor_scope, source_file_id_key)
);

create index if not exists idx_agent_sync_cursors_updated
  on agent_sync_cursors (agent_id, updated_at desc);

create table if not exists agent_raw_chunks (
  id bigserial primary key,
  source_file_id bigint not null references agent_source_files(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  chunk_id text not null,
  sequence integer,
  cursor_start text,
  cursor_end text,
  raw_sha256 text,
  raw_bytes bigint not null default 0,
  raw_body bytea,
  raw_text text,
  compression text,
  encoding text,
  content_type text,
  redaction jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (agent_id, source_file_id, chunk_id)
);

create index if not exists idx_agent_raw_chunks_source_sequence
  on agent_raw_chunks (source_file_id, sequence asc nulls last, id asc);

create index if not exists idx_agent_raw_chunks_sha
  on agent_raw_chunks (raw_sha256) where raw_sha256 is not null;

create table if not exists agent_normalized_events (
  id bigserial primary key,
  raw_chunk_id bigint references agent_raw_chunks(id) on delete set null,
  source_file_id bigint not null references agent_source_files(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  provider text not null default 'unknown',
  event_uid text,
  event_type text,
  role text,
  occurred_at timestamptz,
  source_offset bigint,
  source_line_no integer,
  content_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  redaction jsonb not null default '{}'::jsonb,
  normalized jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_agent_normalized_events_uid
  on agent_normalized_events (agent_id, source_file_id, event_uid)
  where event_uid is not null;

create index if not exists idx_agent_normalized_events_source_line
  on agent_normalized_events (source_file_id, source_line_no asc nulls last, source_offset asc nulls last);

create index if not exists idx_agent_normalized_events_type
  on agent_normalized_events (provider, event_type);

create index if not exists idx_agent_normalized_events_created
  on agent_normalized_events (created_at desc);
`.trim(),
  },
];

export function migrationsEnabled(env = process.env) {
  return envFlag(env, ["AUTO_MIGRATION", "CHATVIEW_AUTO_MIGRATION", "auto-migration"]);
}

export async function runMigrations(sql: any) {
  validateMigrationList();
  const connection = await sql.reserve();
  let locked = false;

  try {
    await lockMigrations(connection);
    locked = true;

    await ensureMigrationTable(connection);
    const applied = await loadAppliedMigrations(connection);
    await assertAppliedChecksums(applied);

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await applyMigration(connection, migration);
    }
  } finally {
    if (locked) {
      await unlockMigrations(connection).catch((error: unknown) => {
        console.error("failed to release migration lock", error);
      });
    }
    connection.release();
  }
}

export async function assertDatabaseReady(sql: any) {
  const rows = await sql`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'schema_migrations'
    ) as exists
  `;

  if (!rows[0]?.exists) {
    throw new Error("database migrations have not been applied; set AUTO_MIGRATION=true before starting the backend");
  }

  const applied = await loadAppliedMigrations(sql);
  const missing = migrations.filter((migration) => !applied.has(migration.id));
  if (missing.length) {
    throw new Error(
      `database is missing migrations: ${missing.map((migration) => `${migration.id}_${migration.name}`).join(", ")}`,
    );
  }

  await assertAppliedChecksums(applied);
}

async function ensureMigrationTable(sql: any) {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      duration_ms integer not null
    )
  `;
}

async function lockMigrations(sql: any) {
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;
}

async function unlockMigrations(sql: any) {
  await sql`select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;
}

async function loadAppliedMigrations(sql: any) {
  const rows = await sql`
    select id, name, checksum
    from schema_migrations
    order by id asc
  `;
  return new Map<string, { name: string; checksum: string }>(
    rows.map((row: any) => [row.id, { name: row.name, checksum: row.checksum }]),
  );
}

async function assertAppliedChecksums(applied: Map<string, { name: string; checksum: string }>) {
  for (const migration of migrations) {
    const row = applied.get(migration.id);
    if (!row) continue;

    const checksum = migrationChecksum(migration);
    if (row.checksum !== checksum) {
      throw new Error(
        `migration ${migration.id}_${migration.name} checksum mismatch; applied ${row.checksum}, current ${checksum}`,
      );
    }
  }
}

async function applyMigration(sql: any, migration: Migration) {
  const start = performance.now();
  const statements = splitSqlStatements(migration.sql);
  const checksum = migrationChecksum(migration);

  const execute = async (runner: any) => {
    for (const statement of statements) {
      await runner.unsafe(statement);
    }
    await runner`
      insert into schema_migrations (id, name, checksum, duration_ms)
      values (${migration.id}, ${migration.name}, ${checksum}, ${Math.round(performance.now() - start)})
    `;
  };

  if (migration.transaction === false) {
    await execute(sql);
  } else {
    await sql.transaction(async (tx: any) => {
      await execute(tx);
    });
  }

  console.log(`applied database migration ${migration.id}_${migration.name}`);
}

function validateMigrationList() {
  const seen = new Set<string>();

  for (const migration of migrations) {
    if (!/^\d{4}$/.test(migration.id)) {
      throw new Error(`invalid migration id: ${migration.id}`);
    }
    if (!/^[a-z0-9_]+$/.test(migration.name)) {
      throw new Error(`invalid migration name: ${migration.name}`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

function migrationChecksum(migration: Migration) {
  return createHash("sha256").update(migration.sql.replace(/\r\n/g, "\n")).digest("hex");
}

function splitSqlStatements(source: string) {
  const statements: string[] = [];
  let statementStart = 0;
  let dollarQuoteTag: string | null = null;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (source.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && next === "'") {
        index++;
      } else if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index++;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (char === "$") {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuoteTag = match[0];
        index += dollarQuoteTag.length - 1;
      }
      continue;
    }

    if (char === ";") {
      const statement = source.slice(statementStart, index).trim();
      if (statement) statements.push(statement);
      statementStart = index + 1;
    }
  }

  const trailingStatement = source.slice(statementStart).trim();
  if (trailingStatement) statements.push(trailingStatement);
  return statements;
}
