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
  content_sha256 text,
  mime_type text,
  encoding text,
  line_count integer,
  mode integer,
  symlink_target text,
  git_repo_root text,
  git_branch text,
  git_commit text,
  git_dirty boolean,
  git_remote_url text,
  deleted_at timestamptz,
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
  line_sha256 text,
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

create index if not exists idx_sessions_deleted_at
  on chat_sessions (deleted_at) where deleted_at is not null;

create index if not exists idx_sessions_git_commit
  on chat_sessions (git_commit) where git_commit is not null;

create index if not exists idx_events_line_sha256
  on session_events (line_sha256) where line_sha256 is not null;

create table if not exists yjs_documents (
  doc_id text primary key,
  session_db_id bigint references chat_sessions(id) on delete set null,
  update bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_yjs_documents_session
  on yjs_documents (session_db_id);

create table if not exists import_tokens (
  id bigserial primary key,
  token text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists import_requests (
  id bigserial primary key,
  token_id bigint references import_tokens(id) on delete set null,
  token_sha256 text,
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

create index if not exists idx_import_requests_received
  on import_requests (received_at desc);

create index if not exists idx_import_requests_token
  on import_requests (token_id, received_at desc);

create table if not exists import_media_blobs (
  id bigserial primary key,
  media_kind text not null default 'audio',
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

create index if not exists idx_import_media_blobs_seen
  on import_media_blobs (last_seen_at desc);

create table if not exists import_request_media (
  id bigserial primary key,
  request_id bigint not null references import_requests(id) on delete cascade,
  media_id bigint not null references import_media_blobs(id) on delete cascade,
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

create index if not exists idx_import_request_media_request
  on import_request_media (request_id, part_index);

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
