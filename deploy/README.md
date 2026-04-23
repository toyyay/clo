# clo deploy

Production deploy follows the same shape as `food`:

- GitHub Actions builds `ghcr.io/toyyay/clo:<short-sha>` on the self-hosted `cd,finland` runner.
- The deploy job calls `deploy-agent` on `prod`.
- `deploy-agent` updates `IMAGE_TAG` for `/root/clo/docker-compose.yml` and runs Docker Compose.
- Cloudflare Tunnel serves `https://clo.vf.lc` to the app bound on `127.0.0.1:3737`.

Production files live in `/root/clo`:

- `docker-compose.yml`
- `.env`
- `pgdata/`

The smoke check endpoint is `https://clo.vf.lc/status-9c8e0f3a2b71` and returns the image build `commit_sha`.
