# Chatview

Status: this is still a work-in-progress deployment target. The public `https://clo.vf.lc` server is staging/development infrastructure, even though some infrastructure names still say `prod`. In project chat, "production" often means this staging deploy. It is fine to rebuild, redeploy, break, or wipe staging database state while the schema and deploy flow are still settling.

Chatview is a local-first viewer for Claude Code, Codex, and Gemini JSONL history collected from multiple machines.

The live web app at `/` is the **sync-v3** client. The legacy v2 client is preserved at `/v2`.

## Layout

- `apps/agent` — Bun agent that tails configured JSONL roots and uploads append chunks.
- `apps/backend` — Bun HTTP server with Postgres projections, filesystem raw-chunk storage, the legacy v2 sync API, and the sync-v3 WebSocket server.
- `apps/backend/sync-v3` — server-side render pipeline, view resolver, repo, ws-server, telemetry.
- `apps/frontend` — legacy React UI served at `/v2`.
- `apps/frontend-v3` — the live React UI. IndexedDB-first, WebSocket-driven, with a service worker for offline shell.
- `packages/sync-v3` — shared contracts (`ViewSpec`, `RenderItem`, ws frame union), used by both the server and the v3 client.

## Sync-v3 model

Source logs are append-only JSONL, so every layer uses monotonic cursors and idempotent writes. The shape of v3 is:

- **Granular subscriptions.** The client describes what it wants with a `ViewSpec` (predicate + tail size + priority + follow-new flag). The server resolves the predicate to a chat set, render-pipelines server-side, and streams `view.snapshot` (metadata only — groups + chats + zero-tail cursor) followed by demand-driven `view.batch`es as the client acks.
- **Render on the server.** Raw normalized events go through `apps/backend/sync-v3/render.ts` into `agent_render_items` rows. Each row carries a payload, a `payload_bytes` count, and pre-parsed markdown blocks for text payloads. The client never re-parses or re-renders from raw JSONL.
- **Materialized aggregates.** Migration `0015_v3_group_aggregates` builds a `v3_group_aggregates` materialized view (host → provider → project, deduped via `min(label)`), refreshed by the server every 60s. The sidebar consumes this directly — no per-render aggregation in the browser.
- **Tails on demand.** `view.snapshot` is metadata-only. The client opens a chat → calls `history.range` for the tail → server replies with a windowed slice → IDB caches it for offline reuse. Same path for `loadOlder`.
- **Follow-new.** When ingest writes a new chat, `notifyAffectedChat` resolves which subscribed views match it via `resolveMatchingViews`, then emits `chat.added` to those clients with a tail. Membership is persisted in `client_view_chats` so the client can recover after reconnect.
- **Self-healing reconnect.** On every WS open the client re-upserts every view it has in IDB. The server's `persistView` is `INSERT ... ON CONFLICT DO UPDATE`, so if the server lost a view's spec but kept its cursor (or vice versa) the next reconnect repairs it.

Frame protocol (NDJSON over WebSocket at `/api/v3/ws`, gated by `WEB_TOKEN`):

- Client → server: `hello`, `view.upsert`, `view.delete`, `view.ack`, `chat.exclude`, `chat.include`, `history.range`, `flow.adjust`, `ping`.
- Server → client: `hello.ok`, `view.snapshot`, `view.batch`, `view.idle`, `view.error`, `chat.added`, `chat.removed`, `history.range.ok`, `evict.suggest`, `pong`.

The full schemas live in `packages/sync-v3/contracts.ts`.

## Frontend v3

`apps/frontend-v3` is a thin React 19 client. State lives in a `useSyncExternalStore`-friendly store (`views-store.ts`); the entry component is just plumbing.

Highlights:

- IndexedDB v5 schema with `[chatId, seq]` keypaths, per-chat `getChatTail` / `getChatRange`, persistent measured row heights for virtualization.
- Virtual scroll with anchor pinning: the top-visible row is captured before any layout-changing event (loadOlder prepend, measure flush, font-scale change, tool-group expand) and restored in a `useLayoutEffect`, so nothing ever jumps under the user.
- Server-side markdown blocks rendered without re-parsing on the client; long messages get a "show more" affordance, tool calls and tool results auto-group into collapsible bundles.
- Service worker (`/sw-v3.js`) with cache namespace `chatview-v3-${BUILD_SHA}`. Pre-caches `/`, `/manifest.webmanifest`, `/app-icon.svg`; navigations are network-first → cached-shell, assets stale-while-revalidate, `/api/*` and `/clo/*` are never cached.
- Loading affordances everywhere there's an async read: skeleton on chat open, sticky pill while `loadOlder` is in flight, dot spinners in the sidebar while a group expand or `Show more` is reading IDB, and a thin indeterminate progress bar under the topbar while the WS is reconnecting or the backlog is non-trivial.
- A clickable sync pill opens a diagnostics popover (RTT, last frame age, throughput, server cursor, per-view detail) so the user can see what's happening without devtools.
- Telemetry: every WS session writes to `v3_client_sessions`, every state transition to `v3_sync_events`, so "is device X stuck?" is a single SQL query.

## Legacy v2

The legacy client is reachable at `/v2`. Its sync model and IndexedDB schema are unchanged from before sync-v3, and the v2 endpoints (`/api/sync`, `/api/v2/sessions/:id/events`, `/api/yjs/...`) are still served. The v2 frontend's old service worker at `/service-worker.js` is now a kill-switch — it self-unregisters on `activate` so `/sw-v3.js` can take over scope `/`.

## Agent → backend

- The agent scans configured roots for Claude, Codex, and Gemini. Defaults are `~/.claude/projects`, `~/.codex/sessions`, and `~/.gemini`; pass repeated `--root kind=path` values or set `ROOTS`.
- For every `.jsonl` file it stores local generation, offset, line number, and tail hash in `~/.chatview-agent/v2-state.json`.
- It sends complete appended spans to `POST /api/agent/v1/append` after the policy handshake at `POST /api/agent/v1/hello`.
- The backend stores raw chunks under `DATA_DIR/filesystem` when `SYNC_RAW_STORAGE=filesystem` is enabled, plus normalized SQL projections in `agent_source_files`, `agent_raw_chunks`, and `agent_normalized_events`. The same ingest path also fills `agent_render_items` and notifies subscribed v3 views.
- If a request fails or all pending records are skipped by policy, the agent does not advance local state.
- Legacy `/api/ingest/batch` uploads are disabled by default and are kept only for an explicit rollback window with `LEGACY_INGEST_ENABLED=true`.

## Drafts (Yjs)

- Each chat gets a Yjs document id `chat:<sessionDbId>` with a single map field `draft`. Future per-chat UI state (attachments, screenshots, audio refs) is meant to live in the same map.
- Browser caches the doc in IndexedDB `ydocs`. Backend persists merged updates in `yjs_documents`.
- The v2 client first calls `POST /api/yjs/sync` for active/top chats, then keeps `/api/yjs/ws` open for low-latency updates. POST sync is the source of truth.

## Environment

Local dev database:

```sh
bun run db:up
```

Backend:

```sh
export DATABASE_URL=postgres://chatview:chatview@localhost:5432/chatview
export AGENT_TOKEN=dev-token
export OPENROUTER_API_KEY=...   # optional, only for transcription
bun run dev:local:backend
```

Agent:

```sh
export BACKEND_URL=http://localhost:3737
export AGENT_TOKEN=dev-token
bun run dev:local:agent
```

Custom roots:

```sh
bun run apps/agent/main.ts scan-once \
  --root claude="$HOME/.claude/projects" \
  --root codex="$HOME/.codex/sessions" \
  --root gemini="$HOME/.gemini"
```

The frontend (v3 at `/`, v2 at `/v2`) is served by the backend on `http://localhost:3737`.

### Backfill

After a fresh schema or a major change to `render.ts`, repopulate `agent_render_items`:

```sh
bun run v3:backfill
```

### Build

```sh
bun run build:frontend-v3   # the live UI
bun run build:frontend      # legacy /v2
bun run build:agent         # single executable at dist/chatview-agent
bun run build:clo           # bundled clo helper
```

## Remote staging

`https://clo.vf.lc` is the shared staging server. SSH/deploy targets and some files use the name `prod` for historical reasons; this is not protected production. Use it for fast iteration, UI checks, schema changes, and deploy flow testing — it can be reset whenever.

CI: pushes to `main` build `ghcr.io/toyyay/clo:<short-sha>` and call the deploy-agent on the staging host, which does `IMAGE_TAG=<sha> docker compose up -d app`. The `deploy-clo` GitHub Actions job verifies via `/status-9c8e0f3a2b71` that the live `commit_sha` matches the pushed SHA.

## iPhone media imports

The import endpoint is `POST /api/imports/media` with `?token=...` or `Authorization: Bearer ...`. The older shortcut-compatible `POST /api/shortcuts/audio` still maps to the same handler. In the v2 web UI, open Settings to create/copy an upload URL and Audio to view uploaded audio, play it, and retry transcription.

Uploaded audio is converted to mono 16 kHz 32 kbps MP3 with FFmpeg before being sent to OpenRouter. Set `OPENROUTER_API_KEY`; the default model is `google/gemini-3-flash-preview` with medium reasoning. The backend checks the key on startup via `GET /api/v1/key`. The app still starts without a key, but Settings shows OpenRouter as missing/error and audio transcription will fail until the key is configured.

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
bun run build:clo
bun run build:frontend
bun run build:frontend-v3
bun run v3:backfill
bun test
```

## macOS agent

The agent has a minimal launchd helper:

```sh
dist/chatview-agent install-launch-agent --backend https://chatview.example.com --token token
```

It writes `~/Library/LaunchAgents/com.chatview.agent.plist` and prints the `launchctl` commands to load or stop it.
