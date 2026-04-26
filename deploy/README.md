# clo deploy

This deploy setup is still work in progress. `https://clo.vf.lc` is the remote staging/development server, not protected production. In project conversation, "production" often means this staging deploy because it is the public remote server.

It is acceptable to rebuild, redeploy, break, or reset `/root/clo/pgdata` and `/root/clo/data` while the first rollout is being prepared.

Staging deploy follows the same shape as `food`:

- GitHub Actions builds `ghcr.io/toyyay/clo:<short-sha>` on the self-hosted `cd,finland` runner.
- The deploy job calls `deploy-agent` on `prod`; that target name is historical and points at staging for this project.
- `deploy-agent` updates `IMAGE_TAG` for `/root/clo/docker-compose.yml` and runs Docker Compose.
- Cloudflare Tunnel serves `https://clo.vf.lc` to the app bound on `127.0.0.1:3737`.

Staging files live in `/root/clo`:

- `docker-compose.yml`
- `.env`
- `data/`
- `pgdata/`

Required deploy environment:

- `POSTGRES_PASSWORD`
- `AGENT_TOKEN`
- `WEB_TOKEN`
- `OPENROUTER_API_KEY`
- `TUNNEL_TOKEN`

The staging app enables startup migrations with `AUTO_MIGRATION=true` in Docker Compose. The backend SQL pool is capped with `DB_POOL_MAX=5`. PostgreSQL is pinned to `postgres:18.3`, with `PGDATA=/var/lib/postgresql/18/docker` and the host bind mounted at `/var/lib/postgresql`, matching the PostgreSQL 18 image layout.

The app container bind-mounts the host application directory `/root/clo/data` at `/data`, sets `DATA_DIR=/data`, and enables `SYNC_RAW_STORAGE=filesystem`. This is host filesystem storage in the deploy directory, not a Docker named volume. Large import media blobs and v2 raw sync chunks are stored under `/root/clo/data/filesystem` with Postgres keeping metadata, hashes, and storage keys.

Legacy `/api/ingest/batch` uploads are disabled by default. Set `LEGACY_INGEST_ENABLED=true` only for a temporary rollback window.

The smoke check endpoint is `https://clo.vf.lc/status-9c8e0f3a2b71` and returns the image build `commit_sha`.
