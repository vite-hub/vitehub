---
title: CLI
description: Run package-owned development workflows through the local Vite config.
navigation.order: 31
icon: i-lucide-terminal-square
---

The ViteHub CLI loads the local Vite config and collects package-contributed command namespaces.
Commands stay owned by the package that understands the workflow, while `vitehub` gives agents and developers one predictable entry point.

## Install and open help

The `vite-hub` framework distribution includes the CLI. The command reads
active Vite plugins, so a missing package integration also means a missing
package-owned command.

```bash [Terminal]
pnpm add vite-hub
pnpm vitehub --help
```

Libraries and advanced integrations that do not use the framework distribution
can install `@vite-hub/cli` directly.

Expected help lists available namespaces.
The Agent Package contributes `agent` and `channels` when `hubAgent()` is active, Database contributes `db` when `hubDb()` is active, Workspace contributes `workspace` when `hubWorkspace()` is active, and the CLI includes the built-in `provision` namespace.

```txt [Output]
Usage: vitehub <namespace> <feature> [args...]
Available namespaces:
  agent       Agent development workflows.
  channels    External Channel registration workflows.
  db          Database development workflows.
  workspace   Workspace development workflows.
  provision   Idempotently create missing provider resources.
```

## Commands

| Command | Status | Owner | Use it for |
| --- | --- | --- | --- |
| `vitehub agent eval` | Opt-in tooling | Agent Package | Run discovered Agent Evals through ViteHub defaults. |
| `vitehub agent info` | Available | Agent Package | Inspect resolved Agent metadata through a running Vite Development Server. |
| `vitehub agent dev` | Available | Agent Package | Talk to a discovered Agent through a running Vite Development Server. |
| `vitehub channels history` | Available | Agent Package | Download one deployed conversation and its attachments. |
| `vitehub channels sync` | Available | Agent Package | Inspect or apply provider-owned webhook registrations for a deployed stage. |
| `vitehub db generate` | Available | Database Package | Refresh generated Database artifacts and generate Drizzle migrations. |
| `vitehub db migrate` | Available | Database Package | Refresh generated Database artifacts and apply Drizzle migrations. |
| `vitehub workspace dev` | Available | Workspace Package | Run commands through a Workspace Session exposed by a Compatible Vite Development Server. |
| `vitehub provision run` | Available | ViteHub CLI plus package Provision Steps | Create missing provider resources idempotently. |

## Synchronize Channel webhooks

Deploy the application stage before registering its Channel webhooks. `channels sync` loads the discovered Agent Definitions with the selected Vite stage, checks that every desired webhook route is live at the exact public HTTPS origin, and then compares the provider state. Telegram is the first supported provider.

The command is read-only by default. Start with sanitized JSON when an agent or another command needs to review the complete plan.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

`--stage staging` loads Vite's stage-specific environment files, such as `.env.staging`; existing process environment values take precedence. Keep the Telegram bot token and webhook secret in Server Env. The command does not accept credentials as flags and does not include them in human or JSON output.

Apply the reviewed plan by repeating the exact origin in `--confirm-origin`. The confirmation is non-interactive, so the same contract works for developers, CI, and coding agents without silently selecting a deployment.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

Use `--agent <name>` or `--channel <id>` to narrow a multi-Agent application. Switching a Telegram Channel to polling, or setting `webhooks: false`, plans removal of an existing Telegram webhook; applying that plan also requires `--allow-delete`, and the current provider URL must belong to the confirmed origin. ViteHub preserves pending updates during registration and removal.

Telegram exposes the registered URL and delivery errors through `getWebhookInfo`, but it does not return the configured secret token or allowed update list. The plan marks those fields as unverifiable. Use `--force` to reapply them when the URL already matches and credential or subscription configuration changed. Telegram accepts public webhook ports 443, 80, 88, and 8443; the CLI rejects other explicit ports before applying.

`channels sync` owns only the provider's mechanical registration. The first Telegram synchronizer subscribes to message updates because that is the built-in Channel's supported inbound event. Admission rules, allowed users, secrets, and additional update types remain in the application. An app that needs a custom adapter, certificate, fixed IP, or connection policy must keep the provider lifecycle application-owned; an app-owned `adapter` is not a synchronization target.

## Download Channel history

`channels history` loads the same stage-specific Agent and Channel configuration, then authenticates to the deployed webhook route with its configured webhook secret. It writes portable message metadata to `history.json` and downloads attachment data into `media/`; Agent traces and tool events are not included.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

A Telegram direct-message Channel infers its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for group conversations and adapters where one Channel serves multiple conversations, issues, or tickets. When a Channel declares multiple webhook registrations, select the deployed route and its authentication with `--webhook <id>`.

The export can only contain history available through the Chat SDK adapter or its configured State Adapter. Telegram's Bot API cannot backfill arbitrary old messages, so its durable fallback uses the configured `threadHistory` window, which defaults to 100 messages retained for seven days. Export before that window expires when the archive is intended for recovery.

## Manage Database migrations

The Database commands refresh the discovered Database Definitions before running Drizzle Kit. When every Database is named, ViteHub runs the command once for each generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db generate --name add-audit-log
pnpm vitehub db generate --custom --name backfill-state
pnpm vitehub db migrate
```

`db generate` forwards Drizzle Kit arguments, supports `--name <name>` for a migration name, and uses `--custom` to create an empty custom migration. `db migrate` accepts forwarded Drizzle Kit migration arguments.

## Run Agent Evals

Use `vitehub agent eval` when the proof is Agent behavior, not just TypeScript.
The Agent namespace includes the command, while Eval authoring and execution keep
their test-only dependencies explicit. Install them before creating an Eval; the
optional path then narrows the Agent Eval Target.

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
```

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts --threshold 90
pnpm vitehub agent eval --output .vitehub/evals/support.json --hide-table
pnpm vitehub agent eval --watch
pnpm vitehub agent eval --no-cache
```

Use `--watch` to rerun affected evals after file changes and `--no-cache` to bypass cached model output. Set `agent.eval.testTimeout` in `vite.config.ts` for long-running model or harness evals.

## Inspect an Agent Definition

Start the app's Vite Development Server, then inspect the resolved metadata for one Agent Definition.
The command does not invoke the Agent Driver.

```bash [Terminal]
pnpm vitehub agent info --agent support
pnpm vitehub agent info --agent support --json
```

The default output summarizes the selected Driver, its execution authority, tools, visible Workspace files and Sources, instructions, Agent Invoker Profiles, warnings, and metadata status.
Execution authority is a resolution-time snapshot of filesystem, network, environment, credential, process, and isolation authority. An `unknown` value means the runtime or provider cannot prove that dimension during inspection; it does not mean restricted or denied. The snapshot describes runtime truth for the inspected context, not an enforcement decision or proof of safety.
Use `--json` for the structured inspection contract at `config.driver.executionAuthority`, and `--url` when Vite is not listening on `http://localhost:5173`.
When multiple Agents are discovered, `--agent` is required.
`agent info` reads resolved runtime metadata from the guarded Agent Dev Loop endpoint exposed by `hubAgent()`.

## Talk to an Agent during development

Start the app's Vite dev server in one terminal.
Then attach the Agent Dev Loop from another terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

Pass a message or `--prompt` for a one-shot invocation, or omit both to enter an interactive session.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support --prompt "/summary"
pnpm vitehub agent dev --agent support -p "/summary"
```

Use `--payload` when the invocation needs event input that would normally come from a Channel, route, webhook, or app transport.
The file can live anywhere in the app, but colocating it as `server/agents/<agent>/dev.payload.json` keeps local fixtures next to the Agent Definition without making them part of production behavior.
It must contain one JSON object shaped for the selected Agent Trigger.
For non-chat triggers, pass `--trigger` and shape the file for that trigger instead of Agent Invocation Context Values.

```json [server/agents/support/dev.payload.json]
{
  "user": {
    "id": "user_123",
    "name": "Local Developer"
  },
  "session": {
    "id": "local-support"
  },
  "meta": {
    "audience": "technical"
  }
}
```

```bash [Terminal]
pnpm vitehub agent dev --agent support --payload server/agents/support/dev.payload.json
pnpm vitehub agent dev --agent support --payload server/agents/support/dev.payload.json -p "/summary"
pnpm vitehub agent dev --agent support --timeout 180000 -p "/summary"
```

Use `--cli` when a Capability attached to the Agent declares a Capability CLI.
Everything after `--` is parsed as the nested Capability CLI command.
Attached Capability CLI Contributions are available to the Agent Dev Loop by default, including for harness-backed Agents; set `defineAgent({ cli: { capabilities: false } })` to hide them from this surface.
During Agent runs, ViteHub renders operation tool calls as command lines, such as `api listCustomers --query '{"status":"active"}'`, instead of dumping the raw input object.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

Expected output includes the resolved payload file path before the Agent Invocation starts.
In interactive mode, type a message or command such as `/summary` at the prompt.

```txt [Output]
Loaded payload: /Users/acme/app/server/agents/support/dev.payload.json
Connected to support at http://localhost:5173
> /summary
```

Prefix input with `!` when you need to run a direct Workspace command through the selected Agent Dev Loop Target.
The selected Agent must declare a writable Workspace.
ViteHub runs the command through that Workspace Session and commits successful changes back to the Workspace Store.

```bash [Terminal]
pnpm vitehub agent dev --agent support "!pnpm test"
pnpm vitehub agent dev --url http://localhost:5173 --timeout 180000 support !pnpm test --filter api
```

Put Agent Dev Loop options before the `!` command; flags after `!` are passed to the Workspace command.
In interactive mode, `!` input bypasses the Agent Driver for that turn.
Use normal messages for Agent reasoning, `!` commands for direct Workspace shell work, and `--cli` for Capability CLI Contributions.

```txt [Output]
Connected to support at http://localhost:5173
> !pnpm test
```

## Run Workspace commands during development

Use `vitehub workspace dev` when you want a direct command against a Workspace without routing through an Agent.
Start the app's Vite dev server first, then run the command from another terminal.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
pnpm vitehub workspace dev --timeout 180000 docs exec "npm run lint"
pnpm vitehub workspace dev --path guides --path examples docs exec pnpm test
```

The command runs through the Workspace dev endpoint exposed by `hubWorkspace()` on the Compatible Vite Development Server.
ViteHub materializes a Workspace Session, executes the command, prints stdout and stderr, and commits the session when the command exits successfully.
Put Workspace Dev options before the Workspace target; use `exec` before one-shot command args.
Repeat `--path <path>` to materialize only those Workspace paths for the command session.
If you omit the command in an interactive terminal, the CLI opens a prompt for repeated Workspace commands.

```txt [Output]
Connected to docs at http://localhost:5173
> pnpm test
```

## Preview provisioning

Use `--dry-run` before writing Provider resources.
Provision never deletes or mutates existing resources, and non-secret ids are written only when a real run applies actions.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Unknown ViteHub CLI namespace` | The package Vite Integration is not installed or is disabled. | Add the package's `hubX()` plugin to `vite.config.ts`. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Provision dry-run reports no actions | A package plan skipped provider lookup because its read credentials are missing. | Supply the provider credentials to inspect existing resources; `--dry-run` still prevents `apply()`. |
| Vercel Provision reports no resources for Blob | `VERCEL_PROJECT_ID` is missing, or the active Blob store is not `vercel-blob`. | Set the project id and select the Vercel Blob driver before rerunning the plan. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` disables the Agent Eval Runner. | Re-enable the Agent integration option for local development. |
| Agent eval times out | The eval case, model call, or harness run exceeds `agent.eval.testTimeout`. | Increase `agent.eval.testTimeout` in `vite.config.ts` or narrow the eval case. |
| Vite config fails while loading a ViteHub plugin import | A fresh npm project is loading `vite.config.ts` as CommonJS, but ViteHub packages are ESM-only. | Set `"type": "module"` in `package.json` or rename the config to `vite.config.mts`. |
| `No Compatible Vite Development Server found` | The app dev server is not running or `--url` points at the wrong port. | Start Vite separately, then pass the dev server URL. |
| `Unknown Workspace Dev target` | The named Workspace is not discovered by the running Vite dev server. | Check the Workspace Definition name and make sure `hubWorkspace()` is active. |
| `Agent Dev Loop command requires workspace.mode: "write"` | A `!` command targeted an Agent without writable Workspace access. | Configure the selected Agent with `workspace: { mode: 'write' }`, or send a normal Agent message instead. |
| Agent Dev Loop request times out | A streamed invocation emitted no events before the inactivity timeout, or a Capability CLI/Workspace command exceeded its wall-clock deadline. | Pass `--timeout <ms>` for the dev-loop operation or inspect the stalled work. |
| `Agent Dev Loop payload file must contain a JSON object` | The `--payload` file is not a JSON object. | Replace the file contents with one object shaped for the selected Agent Trigger. |

## Next steps

- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/server-primitives/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.
