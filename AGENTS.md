# AGENTS.md instructions for vitehub

Code comments: only when necessary; explain *why*, not *what*. If code is self-explanatory, skip comments.

## Git / GitHub

- For GitHub actions (PRs, issues, releases, etc.) use `gh` CLI (not the web UI).
- Never comment on Issues or Pull Request without explicit consent.

## CLI

- `gh`, `vercel`, `wrangler`
- NuxtHub CLI is deprecated: never use `npx nuxthub`. Deployments happen via git push -> Cloudflare CI.

## Agent Context

- Development-only agent guidance belongs under `.agents/`.
- Before architecture or domain work, read `.agents/domain.md`, then use `.agents/CONTEXT-MAP.md` to find relevant context glossaries.
- Do not add new development-context files under `docs/agents/` or `docs/contexts/`; use `.agents/` instead.
