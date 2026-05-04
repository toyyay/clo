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
