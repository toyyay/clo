# Repo Notes

- `https://clo.vf.lc`, `/root/clo`, and the deploy target named `prod` are staging/development infrastructure for this project.
- In project conversation, "production" often means the remote staging deploy. Treat it as staging unless the user explicitly says otherwise.
- It is acceptable to rebuild, redeploy, break, or reset staging data directories while the rollout is still being shaped.
- No real production data should live in this repo or in checked-in deploy folders.

## Branches and deploy

- `main` is the live branch. `/` serves the sync-v3 client (`apps/frontend-v3`), `/v2` serves the legacy v2 client (`apps/frontend`).
- Pushes to `main` trigger `.github/workflows/docker.yml`, which builds `ghcr.io/toyyay/clo:<short-sha>` and calls the deploy-agent on `root@prod` to do `IMAGE_TAG=<sha> docker compose up -d app`.
- The `deploy-clo` job verifies the live `commit_sha` via `https://clo.vf.lc/status-9c8e0f3a2b71` matches the pushed SHA before reporting success.
- Manual deploy if CI is unavailable: `ssh root@prod "cd /root/clo && IMAGE_TAG=<sha> docker compose pull app && IMAGE_TAG=<sha> docker compose up -d app"`. Verify with `curl -fsS https://clo.vf.lc/api/health`.

## Staging credentials (user-authorized for browser smoke tests)

- Browser login token for `https://clo.vf.lc` lives in `/root/clo/.env` on `root@prod` as `WEB_TOKEN=...`. The user explicitly authorized using this token for browser-driven testing — fetch via SSH when needed, do not ask again. Same token gates `/api/v3/ws` and `/api/yjs/ws`.
- Postgres password is also in that `.env` (`POSTGRES_PASSWORD`). Backfill / smoke scripts reach Postgres at `clo-postgres-1:5432/chatview` from the `clo_default` Docker network.
- `AGENT_TOKEN` likewise lives in that file; only needed for ingest tests, never for the web UI.

## Real-world client matrix

This is a personal app for one user. Total ~5 devices that we actually
care about — design around them, not against a hypothetical fleet:

- A primary laptop (macOS, Chrome / Firefox).
- A Boox-style **e-ink Android tablet running Firefox-Android**. Slow
  CPU, monochrome-ish display, JS-heavy pages noticeably lag. The
  display-mode = "eink" branch in `settings.tsx` and the corresponding
  CSS (`:root[data-display="eink"]`) target this device specifically.
- A **colour e-ink** secondary Android device — same Firefox-Android
  rendering quirks, slightly more CPU.
- Two regular phones (one iOS, one Android).

Implications when making changes:

- Every "let's just compute this on the client" idea has to survive
  the e-ink Boox's CPU. Push aggregation to Postgres (materialized
  views + indexes) wherever cheap.
- Render bundle size matters: keep the frontend lean, don't pull in
  heavy markdown / syntax-highlight libraries unless the value is
  obvious. Pre-render Markdown server-side into the typed
  `MarkdownBlock[]` (see `RenderItem.blocks`).
- Network is the bottleneck more often than CPU on phones — prefer
  fewer, smaller frames. Live tail batching belongs on the server.
- We are NOT optimizing for many concurrent users. If a feature would
  need locks / per-user partitioning to work at 1000 users but is
  trivial for one user — pick the trivial version and move on.

## Architecture notes (sync-v3)

- Trust boundary: the only authenticated user is the owner. Backend
  treats the websocket connection as fully privileged once `WEB_TOKEN`
  matched. `query.run` is an intentional escape hatch — frontend can
  send arbitrary read-only SQL, server runs it in a `BEGIN READ ONLY`
  transaction with `statement_timeout = 5s` and a 5000-row cap. This
  exists so we can iterate UI features without inventing new RPC ops
  every time.
- For anything that reads more than a few hundred rows or aggregates,
  prefer **materialized views in `migrations.ts`** over recomputing in
  application code. Pattern: declare the view, add a unique index for
  `REFRESH MATERIALIZED VIEW CONCURRENTLY`, refresh on ingest hooks.
  See `v3_group_aggregates` for the template.
- Live updates: server emits `tick`/notify-style frames so the
  frontend can re-pull the queries it cares about. Per-view diffing is
  not worth the protocol complexity at this scale — just re-run the
  query, the materialized views make it cheap.
- "Magic" silent limits are the enemy. Any cutoff (page size, snapshot
  cap, search hits) MUST surface a `hasMore` flag back to the client,
  or it's a bug. Don't add new limits without a sibling signal.
