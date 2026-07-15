# Babysitter

Babysitter is a [ViteHub](https://github.com/vite-hub/vitehub) agent that owns open pull requests in `vite-hub/vitehub` until each one is merged, closed, or blocked. Every five minutes, it prepares exact-head worktrees and runs up to four Codex agents.

## Run

> [!WARNING]
> Babysitter uses your host and credentials to edit code, push branches, change pull requests, and merge them. Read the [agent instructions](server/agents/babysitter/instructions.md) before running it.

You need Node.js 24, `git`, authenticated [`gh`](https://cli.github.com/) and [`codex`](https://github.com/openai/codex) CLIs, and a clone of `vite-hub/vitehub` at `~/vitehub/vitehub`.

```sh
corepack enable
pnpm install
VITEHUB_WORKTREES_PATH=/path/to/worktrees \
pnpm dev
```

To target another repository, change [`vite.config.ts`](vite.config.ts) and the [agent instructions](server/agents/babysitter/instructions.md).
