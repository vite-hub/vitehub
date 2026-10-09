---
title: CLI
description: Run package-owned development workflows through the local Vite config.
navigation.order: 31
navigation.group: Local tools
icon: i-lucide-terminal-square
---

The ViteHub CLI loads the local Vite config and collects package-contributed command namespaces.
Each invocation resolves each active plugin's CLI contributor once and uses its command namespaces and Provision Steps together. A later invocation resolves fresh contributions.
Commands stay owned by the package that understands the workflow, while `vitehub` gives agents and developers one predictable entry point.
The official [`vite-hub` package on npm](https://www.npmjs.com/package/vite-hub) publishes both `vitehub` and `vite-hub` binaries.

CLI discovery and middleware stages load the application's Vite configuration without installing the development invocation route. Console routes remain configured, and `vite dev` keeps its development invocation endpoint inside the reserved `/_vitehub/agent` namespace. The Console catch-all and an application fallback may enclose this endpoint; exact, parameterized, and wildcard routes still conflict. User-configured routes keep strict conflict checks. The first SSR import can load the generated Agent registry before server internals finish initializing; registry refreshes still reset discovered public URL names.

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
The CLI owns the `inspect` namespace. Plugin command contributions with that name are ignored.
The Agent Package contributes `agent` and `channels` when `hubAgent()` is active, Blob contributes `blob` when `hubBlob()` is active, Database contributes `db` when `hubDb()` is active, Env contributes `env` when `hubEnv()` is active, KV contributes `kv` when `hubKv()` is active, Schedule contributes `schedule` when `hubSchedule()` is active, Workflow contributes `workflow` when `hubWorkflow()` is active, Workspace contributes `workspace` when `hubWorkspace()` is active, and the Console integration contributes `console` when `console` is enabled. The framework contributes `types` and `box`, and the CLI includes the built-in `inspect` and `provision` namespaces. `box` does not load the project config, so it also runs in a deployed container without Vite.

```txt [Output]
Usage: vitehub <namespace> <feature> [args...]

Available namespaces:
  workspace   Workspace development workflows.
  console     Console development workflows.
  agent       Agent development workflows.
  blob        Read and write blobs of the Blob stores in a running Vite + Nitro Development Server.
  channels    External Channel registration workflows.
  db          Database development workflows.
  kv          Read and write keys of the KV stores in a running Vite + Nitro Development Server.
  env         Server Env inspection workflows.
  email       Inspect and preview development Email messages.
  schedule    Run Static Schedule Definitions and inspect or control Runtime Schedules.
  workflow    Start and inspect Workflow runs in development.
  types       Generate ViteHub TypeScript declarations.
  inspect     Inspect discovered Definitions and generated Provider Output.
  provision   Idempotently create missing provider resources.
  box         Serve and check an SSH Box runner. Does not load the project config.
```

## Commands

| Command | Status | Owner | Use it for |
| --- | --- | --- | --- |
| `vitehub agent eval` | Opt-in tooling | Agent Package | Run discovered Agent Evals through ViteHub defaults. |
| `vitehub agent info` | Available | Agent Package | Inspect resolved Agent metadata through a running Vite Development Server. |
| `vitehub agent dev` | Available | Agent Package | Talk to a discovered Agent through a running Vite Development Server. |
| `vitehub agent invocations` | Available | Agent Package | List, inspect, follow, or cancel records in the application's Agent Invocation journal, locally or on a deployed Console. |
| `vitehub blob list` | Available | Blob Package | List blobs of a Blob store, one page at a time. |
| `vitehub blob head` | Available | Blob Package | Show the metadata of one blob. |
| `vitehub blob get` | Available | Blob Package | Download one blob to a file or to stdout, byte for byte. |
| `vitehub blob put` | Available | Blob Package | Upload one file as a blob and print what changed. |
| `vitehub blob del` | Available | Blob Package | Delete one blob and print what changed. |
| `vitehub channels history` | Available | Agent Package | Download one deployed conversation and its attachments. |
| `vitehub channels sync` | Available | Agent Package | Inspect or apply provider-owned webhook registrations for a deployed stage. |
| `vitehub channels replay` | Available | Agent Package | Replay stored Channel history through an Agent from a development server or authenticated Console. |
| `vitehub console dev` | Available | Console integration | Start the app's development command with deterministic Console fixture data. |
| `vitehub connections` | Available | Connections Package | Connect OAuth accounts, set API keys, list Connections, read activity, and approve or deny writes. |
| `vitehub env inspect` | Available | Env Package | List declared Server Env variables and their status without values. |
| `vitehub env check` | Available | Env Package | Fail CI or a deploy step when Server Env would not load for a stage. |
| `vitehub email outbox` | Available | Email Package | List, show, or clear messages captured by a running Vite + Nitro Development Server. |
| `vitehub email preview` | Available | Email Package | Render a `server/emails` template locally without sending it. |
| `vitehub db generate` | Available | Database Package | Refresh generated Database artifacts and generate Drizzle migrations. |
| `vitehub db migrate` | Available | Database Package | Refresh generated Database artifacts and apply Drizzle migrations. |
| `vitehub kv list` | Available | KV Package | List the keys of one KV store, one page at a time. |
| `vitehub kv get` | Available | KV Package | Print the value of one key. |
| `vitehub kv has` | Available | KV Package | Check if a key exists. The exit status is 0 or 1. |
| `vitehub kv set` | Available | KV Package | Write the value of one key and print what changed. |
| `vitehub kv del` | Available | KV Package | Delete one key and print what changed. |
| `vitehub schedule list` | Available | Schedule Package | List Runtime Schedules with enabled state, next due time, and last run. |
| `vitehub schedule get` | Available | Schedule Package | Show one Runtime Schedule. |
| `vitehub schedule runs` | Available | Schedule Package | List the recorded runs of one Schedule, newest first. |
| `vitehub schedule attempts` | Available | Schedule Package | List the attempts of one Schedule Run. |
| `vitehub schedule run` | Available | Schedule Package | Run a manual Static Schedule Definition locally or through the deployed Console. |
| `vitehub schedule run-runtime` | Available | Schedule Package | Run one Runtime Schedule now in the development runtime. |
| `vitehub schedule enable` | Available | Schedule Package | Enable one Runtime Schedule. |
| `vitehub schedule disable` | Available | Schedule Package | Disable one Runtime Schedule. |
| `vitehub box check` | Available | Box Package | Start the provider Driver through the SSH runner and report readiness. |
| `vitehub box serve` | Available | Box Package | Serve authenticated SSH commands from this machine. |
| `vitehub workflow start` | Available | Workflow Package | Start a discovered Workflow in the local development runtime. |
| `vitehub workflow get` | Available | Workflow Package | Read a Workflow run. |
| `vitehub workflow cancel` | Available | Workflow Package | Cancel a run when the provider supports it. |
| `vitehub workflow resume` | Available | Workflow Package | Resume a Workflow signal by hook token. |
| `vitehub workspace dev` | Available | Workspace Package | Run commands through a Workspace Session exposed by a Compatible Vite Development Server. |
| `vitehub types prepare` | Available | ViteHub Framework | Prepare generated TypeScript declarations for editors and type checking. |
| `vitehub inspect definitions` | Available | ViteHub CLI plus package inspection contributors | List the Definitions that each active package discovered. |
| `vitehub inspect provider-output` | Available | ViteHub CLI plus package inspection contributors | List generated Provider Output files with secrets redacted. |
| `vitehub provision run` | Available | ViteHub CLI plus package Provision Steps | Create missing provider resources idempotently. |
| `vitehub provision status` | Available | ViteHub CLI plus package Provision Steps | Inspect the latest provider provisioning result. |

## Read and write blobs

Start the app's Vite Development Server, then run `vitehub blob` from another terminal. The commands call the same Blob storage as the running app, so they read and write the blobs that the app uses.

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/ --limit 20
pnpm vitehub blob head avatars/ada.png
pnpm vitehub blob get avatars/ada.png --output ./ada.png
pnpm vitehub blob get reports/2026.csv > report.csv
pnpm vitehub blob put avatars/ada.png ./ada.png --content-type image/png
pnpm vitehub blob del avatars/ada.png
```

Each write command prints what it changed:

```txt [Output]
Created blob avatars/ada.png in store default (48213 B, image/png).
Deleted blob avatars/ada.png from store default.
```

Every command accepts `--store <name>`, `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>`. The commands use the Default Blob Store. Pass `--store` to select a named store from `blob.stores`. An unknown store fails and lists the configured stores, with `default` first, as the Console does.

- `list` prints a table of pathname, size, content type, and upload time. `--limit` defaults to 100 and has a maximum of 250. When more blobs exist, stderr shows the `--cursor` value for the next page.
- `head` prints the metadata of one blob. A missing blob exits with status 1.
- `get` writes the file bytes unchanged. Without `--output`, the bytes go to stdout, so redirect them to a file or a pipe. With `--output <file>`, the command writes the file and prints a summary. `--json` needs `--output`, because stdout carries the file bytes otherwise.
- `put` uploads a file relative to the current directory. Without `--content-type`, the Blob storage detects the type from the pathname. The output says if the blob was created or replaced. The created/replaced label is best-effort because it is based on a metadata read immediately before the write; eventual consistency and concurrent writers can make it stale.
- `del` says if the blob existed. Deleting a missing blob changes nothing and exits with status 0. The existed/missing label is best-effort for the same reason, and a concurrent writer can change the object between the metadata read and delete.

The Vite dev endpoint forwards a JSON request body, so `put` sends the file as base64 and accepts files up to 8 MiB. The CLI checks the size before it reads the file. `get` returns the raw bytes as a stream. There is no `sign` command.

Errors go to stderr, or into `{ "error": { "code", "message" } }` on stdout with `--json`. The commands do not print blob URLs, because a signed URL can carry credentials. Metadata values under secret names, such as `token`, are redacted, as the Console Blob page does.

The commands use a guarded dev endpoint that `hubBlob()` registers only on the Development Server. The endpoint forwards each operation into the Nitro dev environment, which owns the Blob storage. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 and the CLI prints that the host is not supported. Deployed runtimes do not expose the endpoint.

## Inspect the Email development outbox

When a Vite development server has Email enabled, inspect the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Use `--json` for machine-readable output. The outbox is available only in `vite dev` and is cleared when the server restarts. Use `vitehub email preview <template>` to render a `server/emails` template without sending it.

## Inspect Server Env

The Env integration contributes commands that report the status of declared Server Env values without printing their values.

```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```

Both commands load the Vite config in the selected stage mode, including `.env.<stage>` files, with process environment values taking precedence. They list each declared variable with its status, source, required, and secret flags. `env check` exits with status `1` when loading Server Env would fail, so it can gate CI or deployment steps.

## Inspect Definitions and Provider Output

`vitehub inspect` reads the same package-owned summaries that the Console shows. It does not start a server or call a provider. Each active package contributes its own kind: `agent`, `auth`, `browser`, `channel`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

```bash [Terminal]
pnpm vitehub inspect definitions
pnpm vitehub inspect definitions --kind rate-limit
pnpm vitehub inspect definitions --json
```

```txt [Output]
Rate Limits (rate-limit): 1
  checkout  server/api/checkout.post.ts  [require-rate-limit]
    Limit: 10
    Window: 1m
    Enforcement: Strict
    Provider failure: Deny
    Source location: 4:9
```

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`. Each Definition has `name`, `file` relative to the project root, `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the available kinds.

`inspect provider-output` lists the Provider Output files that active packages and the deployment preset write, and shows which ones exist. Deployment paths use the preset's default output directory, for example `.output` or `.vercel/output`. Run a production build first to generate deployment output.

```bash [Terminal]
pnpm build
pnpm vitehub inspect provider-output
pnpm vitehub inspect provider-output --json
```

`--json` includes the parsed content of each JSON file. The CLI redacts values under keys that name secrets, such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with embedded credentials. Read [Provider output](/docs/reference/provider-output) for each file's owner and purpose.

Packages contribute inspection through `vitehub.inspect` on their Vite plugin. The owner package defines the summary; the CLI and the Console only render it.

## Inspect Definitions and Provider Output

`vitehub inspect` reads the same package-owned summaries that the Console shows. It does not start a server or call a provider. Each active package contributes its own kind: `agent`, `auth`, `browser`, `channel`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

```bash [Terminal]
pnpm vitehub inspect definitions
pnpm vitehub inspect definitions --kind rate-limit
pnpm vitehub inspect definitions --json
```

```txt [Output]
Rate Limits (rate-limit): 1
  checkout  server/api/checkout.post.ts  [require-rate-limit]
    Limit: 10
    Window: 1m
    Enforcement: Strict
    Provider failure: Deny
    Source location: 4:9
```

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`. Each Definition has `name`, `file` relative to the project root, `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the available kinds.

`inspect provider-output` lists the Provider Output files that active packages and the deployment preset write, and shows which ones exist. Deployment paths use the preset's default output directory, for example `.output` or `.vercel/output`. Run a production build first to generate deployment output.

```bash [Terminal]
pnpm build
pnpm vitehub inspect provider-output
pnpm vitehub inspect provider-output --json
```

`--json` includes the parsed content of each JSON file. The CLI redacts values under keys that name secrets, such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with embedded credentials. Read [Provider output](/docs/reference/provider-output) for each file's owner and purpose.

Packages contribute inspection through `vitehub.inspect` on their Vite plugin. The owner package defines the summary; the CLI and the Console only render it.

## Run the Console with saved data

Keep the app's usual development command after `--`. ViteHub validates the fixture before it starts that command, reports the resolved fixture path and record count on stdout, and passes through the child command's exit status.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev --host 127.0.0.1
```

The command requires an enabled Console integration so the package-owned `console` namespace can be discovered. Read [Console](/docs/development/console#develop-against-a-fixture) for the version 1 fixture shape and storage behavior.

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

`channels history` loads the same stage-specific Agent and Channel configuration, then authenticates to the deployed webhook route with its configured webhook secret. Adapter-backed Channels keep the Chat SDK export. A Channel with `history` exports its Collection items, supports `--query key=value` (repeatable), optional `--thread`, and pages until the Collection ends. Add `--invocations` to join retained Invocations and recorded deliveries to each item.

The join uses `vitehub.channel.key` annotations first. For older Invocations without that annotation, a Channel can provide `history.invocationItem(invocation)`, which returns a history item or `undefined`. The exporter calls `history.key()` and optional `history.thread()` on that item. The journal retains observations and run annotations, but does not retain raw webhook trigger input or trusted `input.context`. Recover only identities supported by retained evidence. A missing item, invalid key, or throwing hook leaves the Invocation unjoined. The exporter scans the journal once per Collection page and never runs the Channel trigger or changes journal records.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

A Telegram direct-message Channel infers its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for group conversations and adapters where one Channel serves multiple conversations, issues, or tickets. When a Channel declares multiple webhook registrations, select the deployed route and its authentication with `--webhook <id>`.

Use `--webhook-path <path>` to export through a different path on the confirmed deployment origin while keeping the selected registration's authentication. This can select the built-in route on an older deployment that does not yet serve a declared `webhooks.path`.

A custom Channel export contains the items returned by its history Collection. With `--invocations`, each item includes `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional retained final `text`. Delivery text is the validated reply before application formatting, including dry-run writes. Retaining this text requires Invocation content storage or `metadataContent` containing `channel.effect.content`.

A Chat SDK export can only contain history available through the adapter or its configured State Adapter. Telegram's Bot API cannot backfill arbitrary old messages, so its durable fallback uses the configured `threadHistory` window, which defaults to 100 messages retained for seven days. Export before that window expires when the archive is intended for recovery.

## Replay Channel history

`vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox` records each run with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` to send multiple values, as with `--filter`. Labels are separate from the history query, non-empty, and limited to 512 characters. Query fields named `label` use `--query label=value`.

Replay requires the development project token or deployed Console authentication. It validates saved items through the Channel trigger without rechecking historical provider signatures. Public webhooks retain signature verification. The Vite development loop uses the host's configured Console journal, so local dry-run runs do not need app-side Invocation configuration.

## Manage Database migrations

The Database commands refresh the discovered Database Definitions before running Drizzle Kit. When every Database is named, ViteHub runs the command once for each generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db generate --name add-audit-log
pnpm vitehub db generate --custom --name backfill-state
pnpm vitehub db migrate
```

`db generate` forwards Drizzle Kit arguments, supports `--name <name>` for a migration name, and uses `--custom` to create an empty custom migration. `db migrate` accepts forwarded Drizzle Kit migration arguments.

## Read and write KV keys

Start the app's Vite Development Server, then run `vitehub kv` from another terminal. The commands call the same KV storage as the running app, so they read and write the keys that the app uses.

```bash [Terminal]
pnpm vitehub kv list --prefix users: --limit 20
pnpm vitehub kv get settings
pnpm vitehub kv has settings
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv set session:42 active --ttl 3600
pnpm vitehub kv set template @./fixtures/template.txt
pnpm vitehub kv del settings
```

Each write command prints what it changed:

```txt [Output]
Created key settings in store default (object).
Created key session:42 in store default (string, TTL 3600 s).
Deleted key settings from store default.
```

Every command accepts `--store <name>`, `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>`. The commands use the Default KV Store. Pass `--store` to select a named store from `kv.stores`. An unknown store fails and lists the configured stores, with `default` first, as the Console does.

- `list` prints one key per line. Pages with line breaks inside keys require `--json` to preserve each key. `--limit` defaults to 100 and has a maximum of 1000. When more keys exist, stderr shows the `--cursor` value for the next page. Some drivers count scanned entries toward the limit, so a page can hold fewer keys than the limit, or none, and still have a next cursor.
- `get` writes a string value unchanged, without adding a newline, and prints other JSON values as formatted JSON. Binary values are written to stdout as bytes, or as base64 with `"encoding": "base64"` in `--json` output. A missing key exits with status 1.
- `has` exits with status 0 when the key exists and 1 when it does not.
- `set` writes a string. Add `--json-value` to parse the value as JSON. Use strings for integers outside JavaScript's safe integer range. JSON input rejects values that underflow to zero or whose decimal magnitude changes during parsing. Use a string to preserve those values. A value that starts with `@` reads a UTF-8 file relative to the current directory. The output says if the key was created or updated. `--ttl <seconds>` sets an expiry and accepts positive fractional seconds. The `fs-lite` driver ignores TTL and Cloudflare KV rounds up to whole seconds with a minimum of 60 seconds, and Upstash requires at least one second and rounds accepted fractional TTLs up to whole seconds. The output reports the effective TTL and prints a notice when the driver ignores or changes the requested expiry.
- `del` says if the key was found. Deleting a missing key changes nothing and exits with status 0.

The KV storage deserializes stored strings that look like JSON, so a string such as `"2026"` can read back as the number `2026`. There is no `clear` command. Delete keys one at a time so that each change is explicit.

Errors go to stderr, or into `{ "error": { "code", "message" } }` on stdout with `--json`. The commands print values as they are stored and do not redact them, as the Console KV page does. Do not store credentials in keys that you inspect in shared logs.

The commands use a guarded dev endpoint that `hubKv()` registers only on the Development Server. The endpoint forwards each operation into the Nitro dev environment, which owns the KV storage. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 and the CLI prints that the host is not supported. Deployed runtimes do not expose the endpoint.


## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition that sets `manual: true`. It prints the run status, duration, and run id, and exits with `1` when the run fails. Add `--json` to print the run record.

```bash [Terminal]
pnpm vitehub schedule run sync
```

Without `--url`, the command posts to the running Vite Development Server at `VITEHUB_DEV_SERVER_URL` or `http://localhost:5173`. Use `--server <url>` to select another local server.

With `--url`, the command posts to `/_vitehub/schedules/run` on the deployment. That route runs only when the deployment enables the [Console](/docs/development/cli#run-a-schedule-on-demand) with `invoke: true`, and the Console access policy protects it like every other `/_vitehub/**` route. Set the credentials for that policy in the environment:

| Variable                        | Value                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEHUB_CONSOLE_AUTHORIZATION` | An `Authorization` header value that the Console access policy accepts, for example the Basic or Bearer credential that host middleware checks. |
| `VITEHUB_CONSOLE_COOKIE`        | A `Cookie` header value from a signed-in Console session.                                                                                       |
| `CF_ACCESS_CLIENT_ID`           | Cloudflare Access service-token client ID. Forwarded as `CF-Access-Client-Id`.                                                                 |
| `CF_ACCESS_CLIENT_SECRET`       | Cloudflare Access service-token client secret. Forwarded as `CF-Access-Client-Secret`.                                                         |

```bash [Terminal]
VITEHUB_CONSOLE_AUTHORIZATION="Basic $(printf 'admin:%s' "$ADMIN_TOKEN" | base64)" \
  pnpm vitehub schedule run sync --url https://app.example.com
```

The command requires HTTPS for remote URLs and does not follow redirects. A `401`, `403`, or redirect response reports a Console authentication failure. The command never sends the credential to the local Development Server.


## Inspect and control Runtime Schedules

Start the app's Vite Development Server, then run `vitehub schedule` from another terminal. The commands read the Schedule stores of that server runtime, so they show Runtime Schedules and runs that the running app created.

```bash [Terminal]
pnpm vitehub schedule list
pnpm vitehub schedule list --json
pnpm vitehub schedule get digest
pnpm vitehub schedule runs digest --limit 5
pnpm vitehub schedule attempts srun_runtime_digest_2026-05-22T07:00:00.000Z
pnpm vitehub schedule run-runtime digest
pnpm vitehub schedule disable digest
pnpm vitehub schedule enable digest
```

```txt [Output]
ID      TARGET  CRON                           ENABLED  NEXT RUN                  LAST RUN
digest  report  0 9 * * * (Europe/Copenhagen)  yes      2026-05-23T07:00:00.000Z  succeeded 2026-05-22T07:00:00.000Z
Automatic runs: off. No wake driver is installed, so due times do not start runs in this runtime.
```

Every command accepts `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>` (whole milliseconds from 1 to 2147483647). `runs` accepts `--limit <n>`. A failed run makes `schedule run-runtime` exit with status 1 and prints the stored run. Errors go to stderr, or into the JSON body with `--json`.

Schedule operations require a private token scoped to the local project and server instance. The dev server stores it with user-only permissions outside the served project tree, and the CLI reads it locally. Discovery exposes only the server ID. Vite and Nitro both reject operations without the token, including requests to a server exposed with `--host`. Shutdown removes the credential.

The output redacts credentials: values under secret-named keys in Schedule input, URLs with embedded credentials, bearer tokens, and secret assignments in error messages.

The commands use a guarded dev endpoint that `hubSchedule()` registers only on the Development Server. The endpoint forwards each operation into the Nitro dev environment, which owns the Schedule stores and registry. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 and the CLI prints that the host is not supported. Deployed runtimes do not expose the endpoint.

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

Use `--watch` to rerun affected evals after file changes and `--no-cache` to bypass cached model output. Set `agent.eval.testTimeout` in `vite.config.ts` for long-running model or provider evals.

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

`agent info`, `agent dev`, and `channels replay` send a private token to this endpoint. The dev server stores the token with user-only permissions outside the served project tree, and the CLI reads it locally. The discovery request needs no token and returns the Agent names, aliases, trigger names, server root, and token server ID. It does not return the token. The endpoint rejects Agent inspection, Agent messages, Capability CLI calls, Workspace commands, and Channel replay without the token, including requests to a server exposed with `--host`. Run these commands on the machine that runs the dev server.

## Cancel an Agent Invocation

Start the app's Vite + Nitro Development Server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

`hubAgent()` adds a guarded `/__vitehub/agent/invocations/dev` endpoint to the Vite Development Server. The endpoint forwards the request into the Nitro dev environment. There, the Agent Definitions and their `invocations` journals are the same objects that run the application's Invocations, so the cancel reaches the running Invocation with any store, including `createMemoryAgentInvocationStore()`. The endpoint accepts only local hosts and same-origin requests. Use `--url`, `--server`, or `VITEHUB_DEV_SERVER_URL` when Vite is not listening on `http://localhost:5173`, and `--timeout` to change the request timeout.

Nuxt runs Nitro outside the Vite process, and plain Vite has no Nitro. On these hosts the endpoint returns `501`, and the command prints the reason and exits with status 1.

| Output | Meaning | Exit status |
| --- | --- | --- |
| `cancel requested` | A run in the Nitro runtime received an aborted signal. Its final journal state confirms whether it stopped. | 0 |
| `cancel request recorded; execution stop is unconfirmed` | The journal retained the request for a current or future owner. A crashed owner cannot observe it until execution recovery. | 0 |
| `cancel requested, not enforced by <driver>` | The Driver cannot enforce an abort request. Delivery does not confirm that its execution owner received the request. | 0 |
| `already <status>` | The Invocation already finished. | 0 for `cancelled`; 1 for `completed` or `failed` |
| `not found` | The journal has no Invocation with this id. | 1 |

`--json` prints the `AgentInvocationCancelResult` from `invocations.cancel(id)`.

### Inspect and cancel on a deployed app

Pass the deployed app URL with `--url` to list, show, follow, or cancel Invocations through the deployment's [Console](/docs/development/console). The Console must be enabled, and `cancel` also requires `invoke: true`, as the Console cancel button does. The command does not load the project config, so a local config error cannot stop it.

```bash [Terminal]
export VITEHUB_CONSOLE_COOKIE='__Secure-vitehub_console.session_token=...'
pnpm vitehub agent invocations list --url https://app.example.com --status running
pnpm vitehub agent invocations show ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
```

Each command posts to `/_vitehub/rpc/__call` under the app URL, and the Console access policy checks it like a Console page request. Set the credentials that the policy accepts:

| Variable | Value |
| --- | --- |
| `VITEHUB_CONSOLE_COOKIE` | A `Cookie` header value from a signed-in Console session. With `access: 'auth'`, copy the `vitehub_console.session_token` cookie, which has the `__Secure-` prefix on HTTPS. |
| `VITEHUB_CONSOLE_AUTHORIZATION` | An `Authorization` header value, for example the Bearer token that a `host-managed` `authorize` function checks. |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token for `access: 'cloudflare-access'`. |

A URL selects the Console when its host is not `localhost`, or when its path contains `/_vitehub`, such as a Console page URL that you copy from the browser or `http://localhost:3000/_vitehub` for a local production build. Other localhost URLs keep their local meaning. Remote URLs must use HTTPS and must not contain credentials, a query, or a fragment. The command does not follow redirects. A `401` or a redirect reports a Console authentication failure.

The Console has no status filter, so `list --status` reads Console pages until it has `--limit` matches (default 50). `tail` asks the Console only for observations after the last one it printed. The cancel outcomes and exit statuses are the same as in development.

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
Attached Capability CLI Contributions are available to the Agent Dev Loop by default, including for provider-backed Agents; set `defineAgent({ cli: { capabilities: false } })` to hide them from this surface.
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
| `Unknown Definition kind` | No active package contributes that inspection kind. | Use a kind from the printed list, or enable the package integration. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Provision dry-run reports no actions | A package plan skipped provider lookup because its read credentials are missing. | Supply the provider credentials to inspect existing resources; `--dry-run` still prevents `apply()`. |
| Vercel Provision reports no resources for Blob | `VERCEL_PROJECT_ID` is missing, or the active Blob store is not `vercel-blob`. | Set the project id and select the Vercel Blob driver before rerunning the plan. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` disables the Agent Eval Runner. | Re-enable the Agent integration option for local development. |
| Agent eval times out | The eval case, model call, or provider run exceeds `agent.eval.testTimeout`. | Increase `agent.eval.testTimeout` in `vite.config.ts` or narrow the eval case. |
| Vite config fails while loading a ViteHub plugin import | A fresh npm project is loading `vite.config.ts` as CommonJS, but ViteHub packages are ESM-only. | Set `"type": "module"` in `package.json` or rename the config to `vite.config.mts`. |
| `No Compatible Vite Development Server found` | The app dev server is not running or `--url` points at the wrong port. | Start Vite separately, then pass the dev server URL. |
| `vitehub schedule` reports that the host is not supported | The Development Server is Nuxt or plain Vite, so Nitro does not run in the Vite process. | Run the commands against a Vite + Nitro app. |
| `vitehub schedule run-runtime` exits with status 1 | The Schedule is disabled, has no target in the registry, or its handler failed. | Read the printed error or run record, then enable the Schedule or fix the target handler. |
| `Unknown Workspace Dev target` | The named Workspace is not discovered by the running Vite dev server. | Check the Workspace Definition name and make sure `hubWorkspace()` is active. |
| `Agent Dev Loop command requires workspace.mode: "write"` | A `!` command targeted an Agent without writable Workspace access. | Configure the selected Agent with `workspace: { mode: 'write' }`, or send a normal Agent message instead. |
| Agent Dev Loop request times out | A streamed invocation emitted no events before the inactivity timeout, or a Capability CLI/Workspace command exceeded its wall-clock deadline. | Pass `--timeout <ms>` for the dev-loop operation or inspect the stalled work. |
| `Agent Dev Loop payload file must contain a JSON object` | The `--payload` file is not a JSON object. | Replace the file contents with one object shaped for the selected Agent Trigger. |

## Next steps

- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.

## Run Workflows in development

Activate `hubWorkflow()` and start the app's Vite Development Server.

```bash [Terminal]
pnpm vitehub workflow start welcome --input '{"name":"Ada"}'
pnpm vitehub workflow get <runId> --workflow welcome
pnpm vitehub workflow cancel <runId> --workflow welcome
pnpm vitehub workflow resume <token> --payload '{"approved":true}'
```

The commands use the local Nitro development runtime, so app and CLI runs share state. Plain Vite and Nuxt hosts return `WORKFLOW_DEV_RUNTIME_UNAVAILABLE`. Input and payload accept JSON or `@file`. All commands accept `--json`, `--url`, and `--timeout`. Runs started by app code need `--workflow` for `get` and `cancel`.

Inline runs can be read for five minutes. Inline cancellation, Cloudflare cancellation and resume, and OpenWorkflow cancellation and resume return unsupported-operation errors. OpenWorkflow starts enqueue work and require a worker to execute it. Resume uses an opaque hook token, not a run ID or signal name. Workflow inspection lists Definitions; this CLI adds no run list, replay, or Console run view.
