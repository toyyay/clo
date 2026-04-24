# Chatview

Status: this is still a work-in-progress deployment target. No production data is expected to live in this repo yet, and it is fine to rebuild or wipe pre-prod database state while the schema and deploy flow are still settling.

Chatview is a local-first viewer for Claude Code JSONL history collected from multiple macOS machines.

It has three parts:

- `apps/agent`: Bun agent that tails `~/.claude/projects` and posts appended JSONL events.
- `apps/backend`: Bun HTTP server with Postgres storage and cursor sync API.
- `apps/frontend`: React UI that renders from IndexedDB first, then pulls backend updates in batches.

## Sync Model

The source logs are append-only JSONL files, so every layer uses monotonic cursors and idempotent writes.

Agent to backend:

- The agent polls the Claude projects directory.
- For every `.jsonl` file it stores local `offset` and `lineNo` in `~/.chatview-agent/state.json`.
- It sends only complete appended lines to `POST /api/ingest/batch`.
- The backend deduplicates with `unique (session_db_id, source_line_no)`.
- If a request fails, the agent does not advance local state.

Backend to frontend:

- The browser stores `hosts`, `sessions`, `events`, and `syncCursor` in IndexedDB.
- On open, the UI renders cached IndexedDB data immediately.
- It then calls `POST /api/sync` with `{ cursor, limitBytes }`.
- The backend returns changed hosts/sessions/events, a new cursor, and `hasMore`.
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

Local helper with a project-local state file:

```sh
bun run dev:local:agent
```

Frontend is served by the backend at `http://localhost:3737`.

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
bun run dev:local:agent:scan
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

The next step is to add an explicit production asset build and enable service worker registration behind a small feature flag.
