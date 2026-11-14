---
title: Env, secret, and Email commands
description: Check Server Env for a stage, generate and derive app secrets and Console keys, and read the Email development outbox with the vitehub CLI.
navigation.title: Env and Email
navigation.order: 8
navigation.group: Commands
icon: i-lucide-key-round
---

These commands check your configuration before a deploy, make your app's secrets, and show the email it sent in development. `env` and `secret` need no dev server.

## Inspect Server Env

```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```

Both list each declared Server Env variable with its status, source, and required and secret flags, never its value. They load the Vite config in the stage mode, with its `.env.<stage>` files, and process values win. `env check` exits with status `1` when Server Env would fail to load, so it can gate CI or a deploy.

## Generate and derive secrets

```bash [Terminal]
pnpm vitehub secret generate
VITEHUB_SECRET=... pnpm vitehub secret derive myapp:webhooks
pnpm vitehub secret console-key ci
```

| Command | What it prints |
| --- | --- |
| `secret generate` | 32 random bytes as base64, for [`VITEHUB_SECRET`](/docs/env/app-secret). |
| `secret derive <purpose>` | `deriveSecret(purpose)` for the `VITEHUB_SECRET` in the shell. |
| `secret console-key [name]` | A new Ed25519 key pair for [signed Console requests](/docs/console/signed-requests): the `VITEHUB_CONSOLE_KEY_<NAME>` line for the app and the `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` line for the CLI. The name defaults to `CLI`. |

None of them loads the project.

## Inspect the Email development outbox

When the dev server has Email on, read the outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

The outbox exists only in `vite dev`, lives in memory, and empties when the server restarts. Add `--json` for machine-readable output, or `--url` to read a deployed app. The commands need access to the `email` Console section. `clear` asks first on a terminal and refuses elsewhere, so scripts pass `--yes` (or `-y`).

`vitehub email preview <template>` renders a `server/emails` template in your terminal without sending it, and needs no server.
