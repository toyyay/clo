# Chatview

Status: this is still a work-in-progress deployment target. The public `https://clo.vf.lc` server is staging/development infrastructure, even though some infrastructure names still say `prod`. In project chat, "production" often means this staging deploy. It is fine to rebuild, redeploy, break, or wipe staging database state while the schema and deploy flow are still settling.

Chatview is a local-first viewer for Claude Code, Codex, and Gemini JSONL history collected from multiple machines.

It has three parts:

- `apps/agent`: Bun agent that tails configured JSONL roots and uploads append chunks.
- `apps/backend`: Bun HTTP server with Postgres projections, filesystem raw-chunk storage, and cursor sync API.
- `apps/frontend`: React UI that renders from IndexedDB first, then pulls backend updates in batches.

## Sync Model

The source logs are append-only JSONL files, so every layer uses monotonic cursors and idempotent writes.

Agent to backend:

- The default `run` and `scan-once` commands use the v2 agent pipeline.
- The agent scans configured roots for Claude, Codex, and Gemini. Defaults are `~/.claude/projects`, `~/.codex/sessions`, and `~/.gemini`; pass repeated `--root kind=path` values or set `ROOTS`.
- For every `.jsonl` file it stores local generation, offset, line number, and tail hash in `~/.chatview-agent/v2-state.json`.
- It sends complete appended spans to `POST /api/agent/v1/append` after the server policy handshake at `POST /api/agent/v1/hello`.
- The backend stores raw chunks under `DATA_DIR/filesystem` when `SYNC_RAW_STORAGE=filesystem` is enabled, and stores normalized SQL projections in `agent_source_files`, `agent_raw_chunks`, and `agent_normalized_events`.
- If a request fails or all pending records are skipped by policy, the agent does not advance local state.
- Legacy `/api/ingest/batch` uploads are disabled by default and are kept only for an explicit rollback window with `LEGACY_INGEST_ENABLED=true`.

Backend to frontend:

- The browser stores `hosts`, `sessions`, `events`, and `syncCursor` in IndexedDB.
- On open, the UI renders cached IndexedDB data immediately.
- It then refreshes metadata first and lazily fetches active chat events from `/api/v2/sessions/:id/events`.
- Full offline event sync uses `POST /api/sync` with `{ cursor, limitBytes }`.
- The backend returns changed hosts/sessions/events, a compound cursor, and `hasMore`.
- The frontend repeats while `hasMore` is true.
- Default response target is 2 MB.

WebSockets/SSE can be added later as a wake-up hint, but the POST cursor sync is the source of truth.

Draft state:

- Each chat gets a Yjs document id: `chat:<sessionDbId>`.
- The document currently uses `doc.getMap("state")` with one field: `draft`.
- Future UI state can live in the same map: attachments, screenshots, audio references, etc.
- Browser state is cached in IndexedDB `ydocs`.
- Backend state is stored as merged Yjs updates in Postgres `yjs_documents`.
- The browser first calls `POST /api/yjs/sync` for active/top chats, then keeps `/api/yjs/ws` open for faster updates.
- POST sync remains the source of truth; WebSocket is only a low-latency propagation path.

## Environment

Local dev database:

```sh
bun run db:up
```

Backend:

```sh
export DATABASE_URL=postgres://user:password@localhost:5432/chatview
export AGENT_TOKEN=dev-token
export OPENROUTER_API_KEY=...
bun run dev:backend
```

For the bundled local compose database:

```sh
export DATABASE_URL=postgres://chatview:chatview@localhost:5432/chatview
export AGENT_TOKEN=dev-token
bun run dev:backend
```

Or use the local helper:

```sh
bun run dev:local:backend
```

Agent:

```sh
export BACKEND_URL=http://localhost:3737
export AGENT_TOKEN=dev-token
bun run dev:agent
```

Custom roots example:

```sh
bun run apps/agent/main.ts scan-once \
  --root claude="$HOME/.claude/projects" \
  --root codex="$HOME/.codex/sessions" \
  --root gemini="$HOME/.gemini"
```

Local helper with a project-local state file:

```sh
bun run dev:local:agent
```

Frontend is served by the backend at `http://localhost:3737`.

## Remote Staging

The remote deploy at `https://clo.vf.lc` is the shared staging server. The SSH/deploy target and some files may use the name `prod` for historical reasons, but this is not a protected production environment.

Use this staging server for fast iteration, UI checks, schema changes, and deploy flow testing. It can be rebuilt or reset when needed, and no real production data should be assumed there.

## iPhone Media Imports

The import endpoint is `POST /api/imports/media` with `?token=...` or `Authorization: Bearer ...`.
The older shortcut-compatible endpoint `POST /api/shortcuts/audio` still maps to the same handler.
In the web UI, open Settings to create/copy an upload URL and open Audio to view uploaded audio, play it, and retry transcription.

Uploaded audio is converted to mono 16 kHz 32 kbps MP3 with FFmpeg before being sent to OpenRouter.
Set `OPENROUTER_API_KEY`; the default model is `google/gemini-3-flash-preview` with medium reasoning.
The backend checks the OpenRouter key on startup through `GET /api/v1/key`. The app still starts without a key, but Settings shows OpenRouter as missing/error and audio transcription will fail until the key is configured.

## Commands

```sh
bun run dev:backend
bun run dev:agent
bun run dev:local:backend
bun run dev:local:agent
bun run dev:local:agent:legacy
bun run dev:local:agent:scan
bun run dev:local:agent:legacy:scan
bun run agent:scan
bun run db:up
bun run db:down
bun run build:agent
bun run build:frontend
```

`bun run build:agent` creates a single executable at `dist/chatview-agent`.

## macOS Agent

The agent has a minimal launchd helper:

```sh
dist/chatview-agent install-launch-agent --backend https://chatview.example.com --token token
```

It writes `~/Library/LaunchAgents/com.chatview.agent.plist` and prints the `launchctl` commands to load or stop it.

## Offline UI

The frontend is already IndexedDB-backed and works from cached data after the shell has loaded once. A prepared service worker lives at `apps/frontend/service-worker.js`, but the app does not register it yet.

Service worker/PWA activation is intentionally deferred for now so normal web deploys remain simple during active staging development.
