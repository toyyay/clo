# Repo Notes

- This project is work in progress and is still being shaped on a remote staging/development server.
- The public `clo.vf.lc` deploy, `/root/clo`, and the SSH/deploy target named `prod` are staging infrastructure, not a protected production environment.
- In conversation the word "production" is often used loosely to mean this remote staging deploy. Treat it as staging unless the user explicitly says otherwise.
- It is acceptable to rebuild, redeploy, break, or reset staging data directories while schema and compose settings are still changing.
- No real production data should live in this repo or in the checked-in deploy folders.
- Prefer simple environment variable names without project-specific prefixes; legacy prefixed names should only be treated as compatibility fallbacks.
