---
title: Env, secret, and Email commands
description: Check Server Env for a stage, generate and derive app secrets and Console keys, and read the Email development outbox with the vitehub CLI.
navigation.title: Env and Email
navigation.order: 8
navigation.group: Commands
icon: i-lucide-key-round
---

The Env package adds `env` and `secret`, and the Email package adds `email`. `env` and `secret` need no dev server.

## Inspect Server Env

These commands report the status of declared Server Env values, without the values.

```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```

Both load the Vite config in the stage mode, with `.env.<stage>` files, and process values win. They list each declared variable with status, source, and required and secret flags. `env check` exits with status `1` when Server Env would fail to load, so it can gate CI or deploys.

## Generate and derive secrets

```bash [Terminal]
pnpm vitehub secret generate
VITEHUB_SECRET=... pnpm vitehub secret derive myapp:webhooks
pnpm vitehub secret console-key ci
```

`secret generate` prints 32 random bytes as base64 for [`VITEHUB_SECRET`](/docs/env/app-secret). `secret derive <purpose>` prints `deriveSecret(purpose)` for the `VITEHUB_SECRET` in the shell. `secret console-key [name]` prints a new Ed25519 key pair for [signed Console requests](/docs/console/signed-requests): the `VITEHUB_CONSOLE_KEY_<NAME>` line for the app and the `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` line for the CLI. The name defaults to `CLI`. None of them loads the project.

## Inspect the Email development outbox

When the dev server has Email on, read the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Add `--json` for machine-readable output. The outbox exists only in `vite dev` and empties when the server restarts. `vitehub email preview <template>` renders a `server/emails` template without sending it, in your terminal, with no server.

The commands run `email.outbox-list`, `email.outbox-show`, and `email.outbox-clear` in the `email` Console section, so you need access to that section. `email.outbox-clear` is destructive: `vitehub email outbox clear` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The `email.preview` operation renders a template through the same RPC. The written `vitehub email preview` command renders in your terminal without a server. The generated commands `vitehub email outbox list`, `outbox show`, and `outbox clear` print JSON.

