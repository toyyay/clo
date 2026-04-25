# clo deploy

This deploy setup is still work in progress. No production data should be assumed here yet; resetting `/root/clo/pgdata` is acceptable while the first rollout is being prepared.

Production deploy follows the same shape as `food`:

- GitHub Actions builds `ghcr.io/toyyay/clo:<short-sha>` on the self-hosted `cd,finland` runner.
- The deploy job calls `deploy-agent` on `prod`.
- `deploy-agent` updates `IMAGE_TAG` for `/root/clo/docker-compose.yml` and runs Docker Compose.
- Cloudflare Tunnel serves `https://clo.vf.lc` to the app bound on `127.0.0.1:3737`.

Production files live in `/root/clo`:

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

The production app enables startup migrations with `AUTO_MIGRATION=true` in Docker Compose. The backend SQL pool is capped with `DB_POOL_MAX=5`. PostgreSQL is pinned to `postgres:18.3`, with `PGDATA=/var/lib/postgresql/18/docker` and the host bind mounted at `/var/lib/postgresql`, matching the PostgreSQL 18 image layout.

The app container mounts `/root/clo/data` at `/data` and sets `DATA_DIR=/data`. Large import media blobs are stored there with Postgres keeping metadata, hashes, and storage keys.

The smoke check endpoint is `https://clo.vf.lc/status-9c8e0f3a2b71` and returns the image build `commit_sha`.
