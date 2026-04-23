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
