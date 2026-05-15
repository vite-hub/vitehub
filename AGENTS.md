# Agent Instructions

Code comments: only when necessary; explain *why*, not *what*. If code is self-explanatory, skip comments.

## Git / GitHub

- For GitHub actions (PRs, issues, releases, etc.) use `gh` CLI, not the web UI.
- Never comment on Issues or Pull Requests without explicit user consent.

## CLI

- Available CLIs include `gh`, `vercel`, and `wrangler`.
- NuxtHub CLI is deprecated: never use `npx nuxthub`.
- Deployments happen via git push to Cloudflare CI.

## Agent Knowledge

- Use `agents/CONTEXT.md` for the project glossary.
- Use `agents/adr/` for agent-facing architectural decisions.
- Use `agents/skills/` for reusable agent workflow guidance.
- Keep `AGENTS.md` as an index. Put detailed behavior in focused Markdown files under `agents/` so agents can load only what they need.
