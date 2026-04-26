# Repo Notes

- `https://clo.vf.lc`, `/root/clo`, and the deploy target named `prod` are staging/development infrastructure for this project.
- In project conversation, "production" often means the remote staging deploy. Treat it as staging unless the user explicitly says otherwise.
- It is acceptable to rebuild, redeploy, break, or reset staging data directories while the rollout is still being shaped.
- No real production data should live in this repo or in checked-in deploy folders.
