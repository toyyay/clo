# Repo Notes

- `https://clo.vf.lc`, `/root/clo`, and the deploy target named `prod` are staging/development infrastructure for this project.
- In project conversation, "production" often means the remote staging deploy. Treat it as staging unless the user explicitly says otherwise.
- It is acceptable to rebuild, redeploy, break, or reset staging data directories while the rollout is still being shaped.
- No real production data should live in this repo or in checked-in deploy folders.

## Staging credentials (user-authorized for browser smoke tests)

- Browser login token for `https://clo.vf.lc` lives in `/root/clo/.env` on `root@prod` as `WEB_TOKEN=...`. The user explicitly authorized using this token for browser-driven testing — fetch via SSH when needed, do not ask again. Same token gates `/api/v3/ws` and `/api/yjs/ws`.
- Postgres password is also in that `.env` (`POSTGRES_PASSWORD`). Backfill / smoke scripts reach Postgres at `clo-postgres-1:5432/chatview` from the `clo_default` Docker network.
- `AGENT_TOKEN` likewise lives in that file; only needed for ingest tests, never for the web UI.
