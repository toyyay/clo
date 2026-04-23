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
