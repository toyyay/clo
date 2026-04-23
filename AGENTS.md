# Repo Notes

- This project is work in progress and is still being shaped for its first real production rollout.
- No production data should live in this repo or in the checked-in deploy folders.
- During pre-deploy setup it is acceptable to reset local or pre-prod Postgres data directories while schema and compose settings are still changing.
- Prefer simple environment variable names without project-specific prefixes; legacy prefixed names should only be treated as compatibility fallbacks.
