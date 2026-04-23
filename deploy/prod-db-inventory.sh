#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-root@prod}"
REMOTE_DIR="${REMOTE_DIR:-/root/clo}"
START_POSTGRES=1
SHOW_SAFE_SAMPLES=0

usage() {
  cat <<'EOF'
Usage: deploy/prod-db-inventory.sh [options]

Options:
  --remote HOST        SSH target. Default: root@prod
  --dir PATH          Remote deploy directory. Default: /root/clo
  --no-start          Do not start Postgres; only inspect if already running.
  --safe-samples      Include redacted sample metadata. Never prints raw/body/bytes/tokens.
  -h, --help          Show this help.

Environment overrides:
  REMOTE=root@prod REMOTE_DIR=/root/clo deploy/prod-db-inventory.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      REMOTE="${2:?missing value for --remote}"
      shift 2
      ;;
    --dir)
      REMOTE_DIR="${2:?missing value for --dir}"
      shift 2
      ;;
    --no-start)
      START_POSTGRES=0
      shift
      ;;
    --safe-samples)
      SHOW_SAFE_SAMPLES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ssh -T "$REMOTE" \
  "REMOTE_DIR=$(printf '%q' "$REMOTE_DIR") START_POSTGRES=$START_POSTGRES SHOW_SAFE_SAMPLES=$SHOW_SAFE_SAMPLES bash -s" <<'REMOTE_SCRIPT'
set -uo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

cd "$REMOTE_DIR" || die "cannot cd to $REMOTE_DIR"

if [[ ! -f docker-compose.yml ]]; then
  die "docker-compose.yml not found in $REMOTE_DIR"
fi

if [[ "$START_POSTGRES" == "1" ]]; then
  echo "Starting only the postgres service..."
  docker compose up -d --no-deps postgres </dev/null >/dev/null || die "failed to start postgres service"
fi

echo "Waiting for Postgres..."
ready=0
for _ in {1..120}; do
  if docker compose exec -T postgres pg_isready -U chatview -d chatview </dev/null >/dev/null 2>&1; then
    ready=1
    break
  fi
  printf '.'
  sleep 2
done
echo

if [[ "$ready" != "1" ]]; then
  echo "Postgres did not become ready." >&2
  echo >&2
  echo "== docker compose ps postgres ==" >&2
  docker compose ps postgres </dev/null >&2 || true
  echo >&2
  echo "== pg_isready ==" >&2
  docker compose exec -T postgres pg_isready -U chatview -d chatview </dev/null >&2 || true
  echo >&2
  echo "== postgres logs ==" >&2
  docker compose logs --tail=120 postgres </dev/null >&2 || true
  exit 1
fi

echo "Postgres is ready."

echo
echo "== Compose services =="
docker compose ps </dev/null || die "docker compose ps failed"

echo
echo "== Database inventory =="
docker compose exec -T postgres psql -U chatview -d chatview -v ON_ERROR_STOP=1 -P pager=off <<'SQL' || die "database inventory query failed"
\pset null '(null)'

select now() as checked_at, current_database() as database;

select pg_size_pretty(pg_database_size(current_database())) as database_size;

select
  n.nspname as schema_name,
  c.relname as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
  pg_size_pretty(pg_relation_size(c.oid)) as table_size,
  coalesce(s.n_live_tup, 0)::bigint as estimated_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where c.relkind = 'r'
  and n.nspname = 'public'
order by pg_total_relation_size(c.oid) desc, c.relname;

select
  table_name,
  rows,
  first_at,
  last_at
from (
  select 'agents' as table_name, count(*)::bigint as rows, min(created_at) as first_at, max(last_seen_at) as last_at from agents
  union all select 'projects', count(*)::bigint, min(created_at), max(last_seen_at) from projects
  union all select 'chat_sessions', count(*)::bigint, min(first_seen_at), max(last_seen_at) from chat_sessions
  union all select 'session_events', count(*)::bigint, min(ingested_at), max(ingested_at) from session_events
  union all select 'yjs_documents', count(*)::bigint, min(created_at), max(updated_at) from yjs_documents
  union all select 'import_tokens', count(*)::bigint, min(created_at), max(last_used_at) from import_tokens
  union all select 'import_requests', count(*)::bigint, min(received_at), max(responded_at) from import_requests
  union all select 'import_media_blobs', count(*)::bigint, min(created_at), max(last_seen_at) from import_media_blobs
  union all select 'import_request_media', count(*)::bigint, min(created_at), max(created_at) from import_request_media
) inventory
order by table_name;

select
  coalesce(sum(size_bytes), 0)::bigint as media_bytes,
  pg_size_pretty(coalesce(sum(size_bytes), 0)) as media_size,
  count(*)::bigint as media_files,
  min(created_at) as first_media_at,
  max(last_seen_at) as last_media_seen_at
from import_media_blobs;

select
  event_type,
  role,
  count(*)::bigint as rows,
  min(occurred_at) as first_occurred_at,
  max(occurred_at) as last_occurred_at,
  min(ingested_at) as first_ingested_at,
  max(ingested_at) as last_ingested_at
from session_events
group by event_type, role
order by rows desc, event_type, role;

select
  method,
  path,
  response_status,
  count(*)::bigint as rows,
  pg_size_pretty(sum(request_body_bytes)) as request_body_size,
  pg_size_pretty(coalesce(sum(response_body_bytes), 0)) as response_body_size,
  min(received_at) as first_received_at,
  max(received_at) as last_received_at
from import_requests
group by method, path, response_status
order by rows desc, path, response_status;

select
  case
    when to_regclass('public.schema_migrations') is null then
      'select ''schema_migrations'' as table_name, ''missing'' as status, null::text as id, null::text as name, null::timestamptz as applied_at, null::integer as duration_ms'
    else
      'select ''schema_migrations'' as table_name, ''present'' as status, id, name, applied_at, duration_ms from schema_migrations order by id'
  end
\gexec
SQL

if [[ "$SHOW_SAFE_SAMPLES" == "1" ]]; then
  echo
  echo "== Redacted samples =="
  docker compose exec -T postgres psql -U chatview -d chatview -v ON_ERROR_STOP=1 -P pager=off <<'SQL' || die "redacted sample query failed"
\pset null '(null)'

select
  id,
  hostname,
  platform,
  arch,
  version,
  case when source_root is null then null else '<redacted-path>' end as source_root,
  created_at,
  last_seen_at
from agents
order by last_seen_at desc
limit 20;

select
  cs.id,
  p.display_name as project,
  cs.session_id,
  case when cs.source_path is null then null else '<redacted-path>' end as source_path,
  cs.title,
  cs.size_bytes,
  cs.first_seen_at,
  cs.last_seen_at
from chat_sessions cs
join projects p on p.id = cs.project_id
order by cs.last_seen_at desc
limit 30;

select
  id,
  doc_id,
  session_db_id,
  octet_length(update) as update_bytes,
  created_at,
  updated_at
from yjs_documents
order by updated_at desc
limit 30;

select
  id,
  sha256,
  size_bytes,
  content_type,
  filename,
  extension,
  detected_format,
  metadata - 'tags' as metadata_without_tags,
  created_at,
  last_seen_at
from import_media_blobs
order by last_seen_at desc
limit 30;

select
  id,
  token_sha256,
  method,
  path,
  request_content_type,
  request_body_sha256,
  request_body_bytes,
  response_status,
  response_body_sha256,
  response_body_bytes,
  error,
  received_at,
  responded_at
from import_requests
order by received_at desc
limit 30;
SQL
fi
REMOTE_SCRIPT
