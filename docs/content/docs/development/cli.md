---
title: CLI
description: Run package-owned development workflows through the local Vite config.
navigation.order: 31
navigation.group: Local tools
icon: i-lucide-terminal-square
---

The `vitehub` CLI is one entry point for developers and agents. It loads your Vite config and collects the commands each ViteHub package adds, so each command stays with the package that knows the workflow. Each run reads each active plugin's commands and Provision Steps once. The [`vite-hub` npm package](https://www.npmjs.com/package/vite-hub) ships `vitehub` and `vite-hub` binaries.

The CLI loads your Vite config without the development invocation route, but with Console routes. `vite dev` keeps its development invocation endpoint inside the reserved `/_vitehub/agent` namespace. The Console catch-all and an app fallback may contain it, but exact, parameterized, and wildcard routes still conflict. Your own routes keep strict conflict checks. The first SSR import can load the generated Agent registry before server internals finish starting. Registry refreshes still reset found public URL names.

## Install and open help

The `vite-hub` package includes the CLI. Commands come from active Vite
plugins, so a package that is not set up has no commands.

```bash [Terminal]
pnpm add vite-hub
pnpm vitehub --help
```

Libraries that do not use `vite-hub` can install `@vite-hub/cli` directly.

Help lists the namespaces (command groups) you have:

- `agent`, `channels`, and `conversations` when `hubAgent()` is active.
- `blob`, `db`, `env`, `kv`, `rate-limit`, `schedule`, `workflow`, and `workspace`, each when its plugin is active (`hubBlob()`, `hubDb()`, `hubEnv()`, `hubKv()`, `hubRateLimit()`, `hubSchedule()`, `hubWorkflow()`, `hubWorkspace()`).
- `content` when the app defines `server/content.ts`.
- `console` when `console` is on.
- `types`, `task`, `decisions`, and `sandbox` from the framework. `decisions` and `sandbox` do not load the project config, and `sandbox` also runs in a deployed container without Vite.
- `inspect` and `provision`, built into the CLI. Plugin commands named `inspect` are ignored.

```txt [Output]
Usage: vitehub <namespace> <feature> [args...]

Available namespaces:
  workspace   Workspace development workflows and retained history.
  console     Console development workflows.
  agent       Agent development workflows.
  blob        Read and write blobs of the Blob stores of the app, on the dev server or on a deployed app.
  channels    External Channel registration workflows.
  conversations  Export Channel conversations.
  content     Inspect, edit, delete, restore, publish, and schedule Content documents in the running dev server or a deployed app.
  cms         Inspect the CMS roles and their permissions.
  db          Database development workflows.
  kv          Read and write keys of the KV stores of the app, on the dev server or on a deployed app.
  queue       List Queue Definitions and send a job to one.
  rate-limit  Read and reset Rate Limit counters of the app, on the dev server or on a deployed app.
  env         Server Env inspection workflows.
  secret      Generate and derive application secrets.
  email       Inspect and preview development Email messages.
  schedule    Run Static Schedule Definitions and inspect their recorded runs.
  workflow    Start and inspect Workflow runs in development.
  task        List and run Nitro tasks, such as server/tasks/seed.ts, in the running app.
  types       Generate ViteHub TypeScript declarations.
  decisions   List the Decisions of the app and run one with a text. Does not load the project config.
  sandbox     Serve and check an SSH Sandbox runner. Does not load the project config.
  inspect     Inspect discovered Definitions and generated Provider Output.
  provision   Idempotently create missing provider resources.
```

## Commands

The owner is the package that adds the command.

| Command | Owner | Use it for |
| --- | --- | --- |
| `vitehub agent eval` | Agent | Run Agent Evals with ViteHub defaults. Opt-in tooling. |
| `vitehub agent codex-home` | Agent | Inspect or manage the Agent Codex home. |
| `vitehub agent info` | Agent | Show resolved Agent metadata from the dev server. |
| `vitehub agent dev` | Agent | Talk to an Agent through the dev server. |
| `vitehub agent invocations` | Agent | List, show, follow, export, or cancel Agent Invocation records, locally or on a deployed Console, or wait until none is active. |
| `vitehub blob list` | Blob | List blobs of a Blob store, one page at a time. |
| `vitehub blob head` | Blob | Show the metadata of one blob. |
| `vitehub blob get` | Blob | Download one blob (up to 8 MiB) to a file or stdout, unchanged. |
| `vitehub blob put` | Blob | Upload one file as a blob and print what changed. |
| `vitehub blob del` | Blob | Delete one blob and print what changed. |
| `vitehub blob media` | Blob | Show the media record of one blob: dimensions, hash, alt text, focal point, and crops. |
| `vitehub blob variants` | Blob | List the cached image variants of one blob. |
| `vitehub channels export` | Agent | Alias for `conversations export`. |
| `vitehub conversations export` | Agent | Export one conversation as Markdown or JSON, to stdout or to a directory with its attachments. |
| `vitehub channels history` | Agent | Download one deployed conversation and its attachments with the webhook secret, as `conversations export --format json --output` does. |
| `vitehub channels sync` | Agent | Check or apply provider webhook registrations for a deployed stage. |
| `vitehub channels replay` | Agent | Replay stored Channel history through an Agent, from a dev server or signed-in Console. |
| `vitehub content collections` | Content | List collections and singletons with their fields and document counts. |
| `vitehub content list` | Content | List the documents of one collection with their state, title, and field issues. |
| `vitehub content show` | Content | Print the stored file of one document and its field issues. |
| `vitehub content status` | Content | Show whether each document is draft, published, changed, or deleted, with field issues and schedules. |
| `vitehub content diff` | Content | Print a unified diff of one document from published to draft. |
| `vitehub content revisions` | Content | List the revisions of one document, newest first. |
| `vitehub content edit` | Content | Edit one draft in `$EDITOR` or save it from a file. Respects edit leases unless `--override-lease`. |
| `vitehub content rm` | Content | Delete one draft after confirmation, pinned to its digest. The next publish deletes it from the site. |
| `vitehub content restore` | Content | Save the `--revision` version of a document as its draft, pinned to the draft digest it read. Publishes nothing. |
| `vitehub content publish` | Content | Publish the listed draft documents in one revision after confirmation, pinned to their digests. |
| `vitehub content schedule` | Content | Publish the listed draft documents at a later time, pinned to their digests. |
| `vitehub content scheduled` | Content | List pending, overdue, and failed schedules. |
| `vitehub content unschedule` | Content | Cancel a pending schedule, or dismiss a failed one. |
| `vitehub content sitemap` | Content | Print the sitemap URLs of published documents. |
| `vitehub cms roles` | CMS | List each CMS role with the Content and Comments actions it allows. See [Roles and access](/docs/cms/access). |
| `vitehub console dev` | Console integration | Start the dev command with fixed Console fixture data. |
| `vitehub connections` | Connections | Connect OAuth accounts, set API keys, list Connections, read activity, and approve or deny writes. |
| `vitehub env inspect` | Env | List declared Server Env variables and their status without values. |
| `vitehub env check` | Env | Fail CI or a deploy step when Server Env would not load for a stage. |
| `vitehub secret generate` | Env | Print a new root secret for `VITEHUB_SECRET`. |
| `vitehub secret derive` | Env | Print the secret derived from `VITEHUB_SECRET` for one purpose. |
| `vitehub email outbox` | Email | List, show, or clear messages in the development outbox, on the dev server or with `--url`. |
| `vitehub email outbox-list` | Email | Run `email.outbox-list` and print JSON. `vitehub email outbox list` prints a table. |
| `vitehub email outbox-show` | Email | Run `email.outbox-show <id>` and print JSON. |
| `vitehub email outbox-clear` | Email | Run `email.outbox-clear` (removes every captured message) and print JSON. Asks for `--yes`. |
| `vitehub email preview` | Email | Render a `server/emails` template without sending it. Needs no server. |
| `vitehub db generate` | Database | Refresh generated Database artifacts and generate Drizzle migrations. |
| `vitehub db migrate` | Database | Refresh generated Database artifacts and apply Drizzle migrations. |
| `vitehub db export` | Database | Write a SQL dump of the local SQLite file, or of the deployed database with `--remote`. |
| `vitehub db tables` | ViteHub Framework | List a database's tables with columns and relationships, from the running app or a deployment. |
| `vitehub db rows` | ViteHub Framework | Read one page of a table's rows, sorted or searched, from the running app or a deployment. |
| `vitehub kv list` | KV | List the keys of one KV store, one page at a time. |
| `vitehub kv get` | KV | Print the value of one key. |
| `vitehub kv has` | KV | Check if a key exists. The exit status is 0 or 1. |
| `vitehub kv set` | KV | Write the value of one key and print what changed. |
| `vitehub kv del` | KV | Delete one key and print what changed. |
| `vitehub rate-limit peek` | Rate Limit | Show the counter of one key without consuming a token. |
| `vitehub rate-limit reset` | Rate Limit | Delete the counter of one key, where the provider supports it. |
| `vitehub schedule runs` | Schedule | List the recorded runs of one Schedule, newest first. |
| `vitehub schedule attempts` | Schedule | List the attempts of one Schedule Run. |
| `vitehub schedule run` | Schedule | Run a manual Static Schedule Definition locally, or on a deployment with `--url`. |
| `vitehub decisions list` | Decisions | List the exports of `defineChoices()` results, by file. |
| `vitehub decisions run` | Decisions | Run one Decision with a text and print the selection as JSON, or the questions with `--inspect`. |
| `vitehub queue list` | Queue | List the Queue Definitions of the app and the provider that sends their jobs. |
| `vitehub queue send` | Queue | Send one job to a Queue Definition. |
| `vitehub queue jobs` | Queue | List, show, retry, or clear stored jobs in development or on a Node server with the local provider. Supports `--json` and `--url`. Clearing asks for confirmation, or needs `--yes` without a terminal. |
| `vitehub task list` | ViteHub Framework | List the Nitro tasks that the app registers. |
| `vitehub task run` | ViteHub Framework | Run one Nitro task, such as a seed or a backfill, with the app's bindings. |
| `vitehub usage` | ViteHub Framework | Read token use and cost of Agent Invocations over a time window. |
| `vitehub sandbox check` | Sandbox | Start the provider Driver through the SSH runner and report readiness. |
| `vitehub sandbox serve` | Sandbox | Serve authenticated SSH commands from this machine. With `--drain-timeout <ms>` or `VITEHUB_SANDBOX_DRAIN_TIMEOUT_MS`, SIGTERM and SIGINT refuse new connections and wait up to that time for open ones. |
| `vitehub workflow start` | Workflow | Start a discovered Workflow in the local development runtime. |
| `vitehub workflow get` | Workflow | Read a Workflow run. |
| `vitehub workflow cancel` | Workflow | Cancel a run when the provider supports it. |
| `vitehub workflow resume` | Workflow | Resume a Workflow signal by hook token. |
| `vitehub workspace dev` | Workspace | Run commands in a Workspace Session on the dev server. |
| `vitehub workspace history` | Workspace | List the retained revisions of a Workspace with ref, author, message, and time. |
| `vitehub workspace refs` | Workspace | List the history refs of a Workspace and their head revisions. |
| `vitehub workspace show` | Workspace | Show one revision and its files, or print one file as it was in that revision. |
| `vitehub types prepare` | ViteHub Framework | Prepare generated TypeScript declarations for editors and type checking. |
| `vitehub inspect definitions` | ViteHub CLI plus package inspection contributors | List the Definitions that each active package discovered. |
| `vitehub inspect provider-output` | ViteHub CLI plus package inspection contributors | List generated Provider Output files with secrets redacted. |
| `vitehub provision run` | ViteHub CLI plus package Provision Steps | Create missing provider resources idempotently. |
| `vitehub provision status` | ViteHub CLI plus package Provision Steps | Inspect the latest provider provisioning result. |

## Read and write blobs

Start the dev server, then run `vitehub blob` in another terminal. Each command runs a `blob.*` [operation](/docs/development/operations) of the app, so it uses the app's blobs. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](#run-any-operation).

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/ --limit 20
pnpm vitehub blob head avatars/ada.png
pnpm vitehub blob get avatars/ada.png --output ./ada.png
pnpm vitehub blob get reports/2026.csv > report.csv
pnpm vitehub blob put avatars/ada.png ./ada.png --content-type image/png
pnpm vitehub blob del avatars/ada.png
pnpm vitehub blob media avatars/ada.png
pnpm vitehub blob variants avatars/ada.png --json
```

Each write command prints what it changed:

```txt [Output]
Created blob avatars/ada.png in store default (48213 B, image/png).
Deleted blob avatars/ada.png from store default.
```

Every command takes `--store <name>`, `--json`, `--url <url>` for a deployed app, and `--timeout <ms>`. The default Blob store is used unless you pass `--store`. Store names come from `blob.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints pathname, size, content type, and upload time. `--limit` defaults to 100, at most 250. When more blobs exist, stderr shows the `--cursor` for the next page.
- `head` prints one blob's metadata. A missing blob exits with status 1.
- `get` writes the bytes unchanged, to stdout by default, so redirect them. `--output <file>` writes the file and prints a summary. `--json` needs `--output`.
- `put` uploads a file relative to the current directory. Without `--content-type`, Blob storage guesses the type from the pathname. The output says if the blob was created or replaced. This label is a best guess from a metadata read just before the write, so eventual consistency and concurrent writers can make it wrong.
- `media` prints the blob's [media record](/docs/blob/media). A missing record is built from the object and stored, as `blob.media.get()` does. A missing blob exits with status 1.
- `variants` lists a blob's cached image variants and crop replacements, with transform key, type, and size.
- `put` and `del` refuse paths under `_vitehub/` (`BLOB_RESERVED_PATH`), which ViteHub keeps for itself. `get` and `head` can read them. The CLI replaces an existing blob without asking. The Console asks first (`overwrite: false` makes `blob.put` fail with `BLOB_EXISTS`).
- `del` says if the blob existed, which is a best guess for the same reason. Deleting a missing blob changes nothing and exits with status 0.

Files travel as base64 in a JSON call, so `put` and `get` handle up to 8 MiB. The CLI checks an upload's size before it reads the file. Larger blobs fail with `BLOB_UPLOAD_TOO_LARGE` or `BLOB_DOWNLOAD_TOO_LARGE`, so use the app or your provider's tools. There is no `sign` command. `list` shows every object, including those under `_vitehub/` that the Console hides by default.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. The commands print no object URLs, because a signed URL can carry credentials. `media` prints the record's served route URL, which carries none. Metadata values under secret names, such as `token`, are redacted.

The operations are `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.del`, `blob.media`, and `blob.variants`, in the `blob` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `blob` section. `blob.put` writes and `blob.del` is destructive. `vitehub blob del` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console Blob page uses the same operations.

## Inspect the Email development outbox

When the dev server has Email on, read the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Add `--json` for machine-readable output. The outbox exists only in `vite dev` and empties when the server restarts. `vitehub email preview <template>` renders a `server/emails` template without sending it, in your terminal, with no server.

The commands run `email.outbox-list`, `email.outbox-show`, and `email.outbox-clear` in the `email` Console section, so you need access to that section. `email.outbox-clear` is destructive: `vitehub email outbox clear` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The `email.preview` operation renders a template through the same RPC. The generated commands `vitehub email outbox-list`, `outbox-show`, and `outbox-clear` print JSON.

## Read and reset Rate Limit counters

Read or reset one key's counter of a Rate Limit from `requireRateLimit()`:

```bash [Terminal]
pnpm vitehub rate-limit peek <id> <key>
pnpm vitehub rate-limit reset <id> <key> [--yes]
```

`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, such as a client IP or user ID. Put `--` before a key that starts with a dash. Both commands take `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, they call this project's dev server. With `--url https://app.example.com`, they call a deployed app with the [Console](/docs/development/console) on, using `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE`, or `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

The commands run `rate-limit.peek` (a read) and `rate-limit.reset` in the `rate-limits` Console section. `reset` is destructive: it asks for confirmation on a terminal and refuses elsewhere, so scripts pass `--yes`. The Console **Rate Limits** page uses the same operations.

- The memory provider keeps counters in the server process, so you see only the counters of the process that answers.
- The Cloudflare binding has only `limit()`, which uses a token, so both commands report `unsupported` and exit with status 1.

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
VITEHUB_SECRET=... pnpm vitehub secret derive vitehub:dispatch
```

`secret generate` prints 32 random bytes as base64 for [`VITEHUB_SECRET`](/docs/env/app-secret). `secret derive <purpose>` prints `deriveSecret(purpose)` for the `VITEHUB_SECRET` (or `NUXT_APP_SECRET`) in the shell. Neither loads the project.

## Inspect Definitions and Provider Output

`vitehub inspect` prints the summaries the Console shows, without a server or provider call. A Definition is the code that declares one resource, such as a queue or a rate limit. Each active package adds its own kind: `agent`, `auth`, `browser`, `channel`, `collection`, `content`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

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

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`. Each Definition has `name`, `file` (from the project root), `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the kinds.

`inspect provider-output` lists the Provider Output files (the files a build writes for the host) and shows which exist. Deployment paths use the preset's output directory, such as `.output` or `.vercel/output`. Run a production build first.

```bash [Terminal]
pnpm build
pnpm vitehub inspect provider-output
pnpm vitehub inspect provider-output --json
```

`--json` includes the parsed content of each JSON file. The CLI redacts values under secret keys such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with credentials. See [Provider output](/docs/reference/provider-output) for each file's owner and purpose.

Packages add inspection through `vitehub.inspect` on their Vite plugin. The package defines the summary. The CLI and the Console only show it.

## Run the Console with saved data

Put your dev command after `--`. ViteHub checks the fixture, prints its path and record count, and exits with the command's status.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev --host 127.0.0.1
```

The command needs the Console on, which adds the `console` namespace. See [Console](/docs/development/console#develop-against-a-fixture) for the version 1 fixture shape and storage.

## Synchronize Channel webhooks

Deploy the stage before you register its Channel webhooks. `channels sync` loads the Agent Definitions for the Vite stage, checks that every webhook route is live at the exact public HTTPS origin, and compares the provider state. Telegram is the first supported provider.

The command only reads by default. Use `--json` to get a sanitized plan to review.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

Without `--url`, the command uses `vitehub({ publicUrl })` when it is one string. `--stage staging` loads stage env files such as `.env.staging`, and process environment values win. Keep the Telegram bot token and webhook secret in Server Env. The command takes no credential flags and never prints credentials.

To apply the plan, repeat the exact origin in `--confirm-origin`. This works without prompts, so developers, CI, and agents never pick a deployment by accident. The configured `publicUrl` needs no confirmation, but a `--confirm-origin` you add must match it.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

`--agent <name>` or `--channel <id>` narrows an app with many Agents. Switching a Telegram Channel to polling, or setting `webhooks: false`, plans to remove its webhook. Applying that also needs `--allow-delete`, and the current provider URL must belong to the confirmed origin. ViteHub keeps pending updates during registration and removal.

Telegram's `getWebhookInfo` returns the URL and delivery errors, but not the secret token or allowed update list, so the plan marks those as unverifiable. Use `--force` to reapply them when the URL matches but credentials or subscriptions changed. Telegram accepts ports 443, 80, 88, and 8443. The CLI rejects other explicit ports before it applies.

`channels sync` only registers the webhook. The Telegram synchronizer subscribes to message updates, the one inbound event the built-in Channel supports. Admission rules, allowed users, secrets, and other update types stay in the app. An app that needs a custom adapter, certificate, fixed IP, or connection policy must manage the provider itself. An app-owned `adapter` is not synced.

## Export a Channel conversation

When the app has the Channel operations, `vitehub channels list` lists Channels and their retention, `channels threads` lists a Channel's threads, and `channels conversation` reads one thread's messages in order. `vitehub channels status <agent> <channel>` shows sync health and skipped messages of a [Gmail Channel](/docs/agents/gmail#failed-messages).

`conversations export` calls the `conversations.export` [operation](/docs/development/operations) on the dev server, or on the app at `--url` with the credentials of [Run any operation](#run-any-operation). It needs no webhook secret, only Console access to the `channels` section.

```bash [Terminal]
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat --url https://app.example.com
```

Without `--output`, the text goes to stdout without attachments, and a retention warning goes to stderr. With `--output`, the directory must not exist. It gets the file (`history.json` or `<thread>.md`) and attachments in `media/`. `--media` and `--no-media` override the default. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).

## Download Channel history

`channels history` loads the stage's Agent and Channel configuration and calls the deployed webhook route with its webhook secret. Adapter-backed Channels use the Chat SDK export. A Channel with `history` exports its Collection items, takes repeatable `--query key=value` and optional `--thread`, and pages to the end. `--invocations` joins kept Invocations and recorded deliveries to each item.

The join uses `vitehub.channel.key` annotations first. For older Invocations, a Channel can give `history.invocationItem(invocation)`, which returns a history item or `undefined`, and the exporter calls `history.key()` and optional `history.thread()` on it. The journal keeps observations and run annotations, but not raw webhook input or trusted `input.context`, so recover only identities the kept data supports. A missing item, invalid key, or throwing hook leaves the Invocation unjoined. The exporter scans the journal once per Collection page. It never runs the Channel trigger or changes journal records.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

`--url` defaults to `vitehub({ publicUrl })` when it is one string. A Telegram direct-message Channel finds its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for groups and for adapters where one Channel serves many conversations, issues, or tickets. When a Channel declares several webhook registrations, pick the route and its authentication with `--webhook <id>`.

`--webhook-path <path>` exports through another path on the confirmed origin, with the selected registration's authentication. Use it to reach the built-in route on an older deployment that does not serve a declared `webhooks.path` yet.

A custom Channel export holds the items of its history Collection. With `--invocations`, each item has `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional final `text`. Delivery text is the validated reply before app formatting, including dry-run writes. To keep it, you need Invocation content storage or `metadataContent` with `channel.effect.content`.

A Chat SDK export holds only history the adapter or its State Adapter can give. Telegram's Bot API cannot backfill old messages, so it uses the `threadHistory` window: 100 messages kept for seven days by default. For a recovery archive, export before that window ends.

## Replay Channel history

`vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox` records each run with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` for several values, as with `--filter`. Labels are not part of the history query. They must be non-empty, at most 512 characters. For a query field named `label`, use `--query label=value`.

Replay needs the development project token or deployed Console authentication. It checks saved items through the Channel trigger, without rechecking old provider signatures. Public webhooks still verify signatures. In `vite dev`, replay uses the host's Console journal, so local dry runs need no Invocation setup in the app.

## Manage Database migrations

The Database commands refresh the Database Definitions, then run Drizzle Kit. When every Database is named, ViteHub runs once per generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db generate --name add-audit-log
pnpm vitehub db generate --custom --name backfill-state
pnpm vitehub db migrate
```

`db generate` passes Drizzle Kit arguments through. `--name <name>` names the migration, and `--custom` creates an empty custom migration. `db migrate` also passes Drizzle Kit arguments through.

## Export a Database

`db export` writes a SQL dump of each database, with no build. It reads the local SQLite file by default. `--remote` reads Cloudflare D1 (through the Cloudflare API), D1 HTTP, remote libSQL, or Postgres (through `pg_dump`).

```bash [Terminal]
pnpm vitehub db export
pnpm vitehub db export --remote --stage production --output backups/database.sql
```

| Option | Description |
| --- | --- |
| `--remote` | Read the remote database. Needed for a database that is not a local file. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Export only this database. |
| `--output <file>` | Write this file. Defaults to `.vitehub/exports/database/<name>-<local\|remote>-<time>.sql`. |

See [Export a database](/docs/database/configure#export-a-database) for each driver and the dump format.

## Browse Database tables

`db tables` and `db rows` run `databases.tables` and `databases.browse`, the [operations](/docs/development/operations) of the Console Databases section. They read the running app's Database Definitions, so they work on any driver without a Drizzle Kit config. They never write.

```bash [Terminal]
pnpm vitehub db tables
pnpm vitehub db rows users --limit 20 --sort email --direction desc
pnpm vitehub db rows users --search ada --json
pnpm vitehub db rows users --database analytics --offset 20 --url https://app.example.com
```

`db rows` reads at most 100 rows at a time and cuts cells at 32 KiB. `--offset` pages, `--sort <column>` and `--direction asc|desc` sort, and `--search <text>` matches any column. Without a table, it reads the tables only. A table that does not exist fails with `CONSOLE_NOT_FOUND`. `--database` picks a named database. Access needs the `databases` section, and `databases:read` is enough.

## Read and write KV keys

Start the dev server, then run `vitehub kv` in another terminal. Each command runs a `kv.*` [operation](/docs/development/operations) of the app, so it uses the app's keys. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](#run-any-operation).

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

Every command takes `--store <name>`, `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>`. Commands use the default KV store. `--store` picks a named store from `kv.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints one key per line. Use `--json` when keys contain line breaks. `--limit` defaults to 100, at most 1000. When more keys exist, stderr shows the `--cursor` for the next page. Some drivers count scanned entries toward the limit, so a page can hold fewer keys, or none, and still have a next cursor.
- `get` writes a string value unchanged, with no added newline, and other JSON values as formatted JSON. Binary values go to stdout as bytes, or as base64 with `"encoding": "base64"` in `--json` output. A missing key exits with status 1.
- `has` exits with status 0 when the key exists and 1 when it does not.
- `set` writes a string. `--json-value` parses the value as JSON. JSON input rejects values that underflow to zero or whose decimal size changes when parsed, so use strings for those and for integers outside JavaScript's safe range. A value that starts with `@` reads a UTF-8 file relative to the current directory. The output says if the key was created or updated.
- `--ttl <seconds>` on `set` sets an expiry, and takes positive fractional seconds. The `fs-lite` driver ignores TTL. Cloudflare KV rounds up to whole seconds, at least 60. Upstash needs at least one second and rounds up to whole seconds. The output shows the real TTL and a notice when the driver ignores or changes it.
- `del` says if the key was found. Deleting a missing key changes nothing and exits with status 0.

KV storage parses stored strings that look like JSON, so `"2026"` can read back as the number `2026`. There is no `clear` command, so each delete is explicit.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. Like the Console KV page, the commands print values as stored, without redaction. Do not store credentials in keys you inspect in shared logs.

The operations are `kv.list`, `kv.get`, `kv.has`, `kv.set`, and `kv.del`, in the `kv` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `kv` section. `kv.del` is destructive: `vitehub kv del` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console KV page uses the same operations.


## Run a Decision

A Decision is a `defineChoices()` result that picks options from a text. `decisions list` finds files that call `defineChoices()`, loads them, and prints the exports that hold the result. It skips `node_modules`, `dist`, `build`, `coverage`, and dot folders. There is no registry: the file path is the address. A file that fails to load is listed with its error, and the command exits with status `1`.

```sh
pnpm vitehub decisions list
```

```txt [Output]
FILE                              EXPORT    NAME
server/utils/forecast-choices.ts  forecast  forecast

Run one with: vitehub decisions run server/utils/forecast-choices.ts "<text>"
```

`decisions run <file> <text>` loads the file, calls `resolve()` with the text, and prints the selection as JSON. It calls the definition's gateway, so it reads the app's keys, such as `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`, from the shell or the project's `.env` files. `--inspect` prints the questions and state that `resolve()` would send, without a model call.

```sh
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

The first command's output, with the offline gateway of the [Decisions tutorial](/docs/decisions/get-started):

```json [Output]
{
  "supplier": { "exclude": ["vak"], "include": ["nord"] },
  "chart": { "confidence": 0.8, "ranked": [{ "probability": 0.1, "value": "line" }, { "probability": 0.1, "value": "bar" }], "value": null }
}
```

| Option | Meaning |
| --- | --- |
| `--export <name>` | The export to run when the file has more than one `defineChoices()` export. |
| `--context <json>` | The `context` for `options` functions, such as `'{"tenantId":"t1"}'`. |
| `--inspect` | Print the plan of `inspect()` instead of calling the gateway. |
| `--json` | `decisions list` only: print the files as JSON. |

A Decision error prints `{ "error": { "code", "message" } }` and exits with status `1`. The command loads the file with Vite but without the project config, so imports must use relative paths or package names. Nuxt aliases such as `~~` and auto-imports do not work. See [Decisions server API](/docs/decisions/server-api) for `resolve()` and `inspect()`.

## Run app tasks

A task is a [Nitro task](https://nitro.build/docs/tasks): a file in `server/tasks/` that default-exports `defineTask()`. Use tasks for seeds, backfills, data repair, and one-off admin jobs. `vitehub()` registers each file and turns on Nitro tasks, so you do not set `nitro.serverDir` or `nitro.experimental.tasks`. The task name is the path with `/` replaced by `:`, so `server/tasks/db/seed.ts` is `db:seed`.

```ts [server/tasks/db/seed.ts]
import { useDatabase } from 'vite-hub/database/drizzle'
import { defineTask } from 'vite-hub/task'

export default defineTask({
  meta: { description: 'Add one demo note' },
  async run({ payload }) {
    const { db, schema } = useDatabase('default')
    const title = typeof payload.title === 'string' ? payload.title : 'Hello'
    const [note] = await db.insert(schema.notes).values({ title }).returning()
    return { result: note }
  },
})
```

Start the dev server, then run the task in another terminal. It runs in that server's Nitro runtime, so `useDatabase()`, `kv`, `blob`, and `env` get the same bindings as a request.

```bash [Terminal]
pnpm vitehub task list
pnpm vitehub task run db:seed --payload '{"title":"First note"}' --yes
pnpm vitehub task run db:seed --payload '{"title":"First note","count":3}' --json --yes
pnpm vitehub task run db:seed --url https://app.example.com --yes
```

```json [Output]
{
  "tasks": [
    { "description": "Add one demo note", "name": "db:seed" }
  ]
}
{
  "durationMs": 14,
  "name": "db:seed",
  "result": { "id": 1, "title": "First note" }
}
```

- `--payload <json>` sets the payload from a JSON object. The default is `{}`.
- The command prints the name, `durationMs`, and the `result` from `run()`. A task that throws exits with status 1 and `TASK_FAILED`. The message goes to stderr, or to `{ "error": { "code", "message", "fix" } }` with `--json`. The server log shows the stack.
- An unknown name fails with `TASK_NOT_FOUND`. A task file without `run()` fails with `TASK_NOT_IMPLEMENTED`.
- Nitro runs one instance of a task name at a time per server. A second run while the first is active gets the first run's result.

`vitehub inspect definitions --kind task` lists the files in `server/tasks/` with no server. `task list` asks the running app, so it also shows tasks that `nitro.tasks` declares in the Vite config.

`task list` and `task run` are the `task.list` and `task.run` [operations](/docs/development/operations) in the `tasks` section. They exist when the app has task files or declares `nitro.tasks`. A generated Nitro plugin gives them Nitro's registry, so they also work on a deployment with `--url` and the Console credentials (`task run` needs `console.invoke`). `task run` is `destructive`, so it asks for `--yes`. The `tasks` section has no Console page. Grant it in `console.authorize` with `sections: ['tasks']`, or `'tasks:read'` for listing only.

> [!WARNING]
> A task can change anything the app can. Give `tasks` only to people who may run a seed or a backfill.

`vitehub task` does not support Nuxt, because Nuxt runs its own Nitro and scans `server/tasks` itself when `nitro.experimental.tasks` is on.

Set `nitro: { experimental: { tasks: false } }` to turn tasks off. A task that `nitro.tasks` declares keeps its handler and description.

## Edit and publish Content

Start the dev server, then run `vitehub content` in another terminal. Each command runs a `content.*` [operation](/docs/development/operations) with the app's `server/content.ts`, so it sees the app's drafts and published documents.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content list posts
pnpm vitehub content edit posts hello
pnpm vitehub content diff posts hello
pnpm vitehub content publish --collection posts --id hello
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
```

- `edit` opens the draft in `$EDITOR`, or saves `--file`, and prints the draft's field issues. While another session holds the edit lease, it fails with `CONTENT_LEASE_HELD`, unless you pass `--override-lease`.
- `publish` and `schedule` list the pending changes with their draft digests (content hashes), ask for confirmation, and pin exactly those digests. If a draft is saved in between, the command fails and nothing is published. `--yes` skips the prompt, and `--dry-run` only lists the changes. Without an interactive terminal, they need `--yes`.
- Omit the id for a singleton.

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. Without `--url`, it calls this project's dev server (see [Run any operation](#run-any-operation)). With `--url`, it calls a deployed app with the Console on, using the credentials from [the table below](#run-a-schedule-on-demand). See [Content CLI](/docs/content/cli) for each command's output.

## Run any operation

Every package [operation](/docs/development/operations) is also a command: `vitehub <namespace> <command> [positional] [--key value]`. The namespace is the operation section (or its `cli.namespace`), and the command is its verb (or its `cli.command`), so `agents.list` is `vitehub agents list`. `vitehub inspect definitions --kind operation` lists each operation and its command. `vitehub <namespace> <command> --help` shows the input.

```bash [Terminal]
pnpm vitehub agents list
pnpm vitehub agents status --agent support
pnpm vitehub invocations list --limit 10
pnpm vitehub invocations get ainv_123 --json
pnpm vitehub invocations delete ainv_123 --yes
pnpm vitehub invocations list --url https://app.example.com
```

The generated commands need the Console RPC. `vitehub()` installs it. Standalone `hubKv()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a local development RPC for their storage commands. Other standalone plugins, such as `hubWorkflow()`, `hubSchedule()`, and `hubQueue()`, need a running app with an operation RPC.

Operations that run app code (`workflow.start`, `workflow.resume`, `queue.send`, `task.run`, and `schedule.run`) exist only when `console.invoke` is on. It is on in development and off in a production build, so on a deployment these commands answer "Console operation not found" until you set `console: { invoke: true }`. `task.run` is `destructive`: the command asks for `--yes`, and agents and MCP need approval.

The built-in commands are `vitehub agents list|invoke|status`, `vitehub invocations list|get|cancel|delete|workspace|capabilities`, `vitehub blob list`, `vitehub kv list|get|has|set|del`, `vitehub db tables|rows`, `vitehub definitions list`, `vitehub env get`, `vitehub search query`, `vitehub sections list`, `vitehub usage`, `vitehub documents action`, and `vitehub media action`. `vitehub task list|run` come from the task plugin, and `vitehub queue list|send` from the Queue package. A hand-written command of the same name, such as `vitehub blob list`, wins.

| Option | Use it for |
| --- | --- |
| `--json` | Print JSON, also for a failure: `{ "error": { "code", "message", "fix" } }`. |
| `--yes` | Delete or publish without asking. Without it, a terminal asks first, and no terminal fails. A call marked read only (`readOnlyWhen`), such as `content publish --dry-run`, needs no `--yes`. |
| `--url <origin>` | Call a deployed app with the credentials in the table below. |
| `--input <json>` or `--input @file.json` | Pass the whole input. Flags and positional arguments override it. |
| `--timeout <ms>` | Wait this long for the answer. |

Flags come from the input's JSON Schema:

- A number, whole number, boolean, or string takes its text.
- A list takes repeated flags or commas (`--tags a,b`).
- An object, an unknown value, or a list of objects takes JSON (`--body '{"a":1}'`).
- A nullable value takes the text `null`. A `string | number` input stays a string.
- `url`, `timeout`, `json`, `yes`, and `input` are reserved and cannot be input keys.

Without `--url`, a command calls its own project's dev server, found in `.vitehub/dev-server.json` (`{ url, root }`). The dev server writes this file when it listens and removes it when it closes. Without it, the command uses `VITEHUB_DEV_SERVER_URL`. With neither, it fails with `CLI_R0005`. It never guesses `localhost:5173`, because another project may use that port. The dev RPC names its project in a response header, and the command stops with `INTERNAL_R0025` when it is another project. A Nuxt dev server does not write the file, so pass `--url` or set `VITEHUB_DEV_SERVER_URL`.

A failed command prints `<code>: <message>` and a `Fix:` line on stderr, and exits with `1`. A bad flag value fails with `CLI_R0003` and the usage line. Two operations with the same namespace and command fail the build and the CLI load with `INTERNAL_B0049`. A hand-written command with the same name as a generated one runs instead, as `vitehub content edit` does.

## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition that sets `manual: true`, and prints the run status, duration, run id, and scheduled time. `--json` prints the run record. A failed run still exits with `0`, so read `status` or `error`. An unknown name fails with `SCHEDULE_DEFINITION_NOT_FOUND` (`404`). A definition without `manual: true` fails with `SCHEDULE_MANUAL_RUN_DISABLED` (`403`).

```bash [Terminal]
pnpm vitehub schedule run sync
pnpm vitehub schedule run sync --at 2026-01-31T23:59:00Z
pnpm vitehub schedule run sync --url https://app.example.com
```

`--at` runs the definition as if its cron fired at that time, without checking the cron. The handler gets it as `scheduledAt`, and `vitehub schedule runs <name>` lists the run under it. Use it to test code that depends on the fire time, such as a job near midnight or on a month's last day. The value is an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00+01:00`. No time zone, a date only, or a day that does not exist (`2026-02-30`) fails with `SCHEDULE_INVALID_SCHEDULED_AT` (`400`), and nothing runs.

`schedule run` is the `schedule.run` [operation](/docs/development/operations) of the Schedules section. Without `--url`, the dev server runs the definition in its Nitro runtime, with the app's Nitro plugins and dev bindings, and the run shows in `vitehub schedule runs <name>`. With `--url`, it calls the deployment with the credentials in the [table above](#run-any-operation). The deployment runs only definitions that the [Console](/docs/development/console) installed with `invoke: true`, which is on in development and off in a production build.

The Console Schedules page runs the same operation. A read-only grant (`"schedules:read"`) can list runs but cannot run a Schedule.

### Signed dispatch

A CI job without a Console login can still run a Schedule. When `VITEHUB_DISPATCH_KEY` (or `VITEHUB_SECRET`) is set, `vitehub schedule run <name> --url <origin>` signs the input and posts it to `/_vitehub/schedules/run`, which takes only signed requests. Without a key, it calls the Console RPC with the Console credentials. Both need HTTPS except on localhost, and reject URL credentials, queries, and fragments before they send. The deployment derives the dispatch key from its [`VITEHUB_SECRET`](/docs/env/app-secret).

```bash [Terminal]
# Once, where the deployment's root secret is available:
VITEHUB_SECRET=... pnpm vitehub secret derive vitehub:dispatch
```

The signature covers the operation (`schedule.run`), the exact body (`{ "name": "sync" }`), the time, a one-time nonce, and the actor. The deployment rejects requests more than five minutes old or ahead, reused nonces, and keys of other deployments. A signed request skips the Console sign-in check and never falls back to a Console session, so a bad signature is always `401`. An edge such as Cloudflare Access still applies. The actor is self-declared and only logged.

> [!WARNING]
> Nonces are kept per server process. A deployment with several instances can accept a replay on another instance within the five minutes.

## Run and inspect Schedules

Start the dev server, then run `vitehub schedule` in another terminal. `runs` and `attempts` read that server's Schedule Run store, so they show the runs the app recorded: manual runs and Process Runtime runs.

```bash [Terminal]
pnpm vitehub schedule runs digest --limit 5
pnpm vitehub schedule runs digest --json
pnpm vitehub schedule attempts srun_static_digest_2026-05-22T07:00:00.000Z
```

```txt [Output]
RUN                                          STATUS     SCHEDULED AT              ATTEMPTS  ERROR
srun_static_digest_2026-05-22T07:00:00.000Z  succeeded  2026-05-22T07:00:00.000Z  1         -
```

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. `runs` takes `--limit <n>`. Errors go to stderr, or to the JSON body with `--json`. `schedule.runs` and `schedule.attempts` are `read` operations of the Schedules section.

The output redacts URLs with credentials, bearer tokens, and secret assignments in error messages. When the store cannot list the full history, the command fails with `SCHEDULE_HISTORY_INCOMPLETE` (`503`). An unknown run id fails with `SCHEDULE_RUN_NOT_FOUND` (`404`).

## Run Agent Evals

Use `vitehub agent eval` to test what an Agent does, not only its types.
Evals need test-only dependencies, so install them before you write one.
An optional path runs only one eval file.

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

`--watch` reruns affected evals on file changes. `--no-cache` skips cached model output. For slow evals, set `agent.eval.testTimeout` in `vite.config.ts`.

## Inspect an Agent Definition

Start the dev server, then print the resolved metadata of one Agent Definition.
The command does not run the Agent.

```bash [Terminal]
pnpm vitehub agent info --agent support
pnpm vitehub agent info --agent support --json
```

The output shows the Driver (the code that runs the Agent), its execution authority, tools, visible Workspace files and Sources, instructions, Invoker Profiles, warnings, and metadata status.
Execution authority is a snapshot of what the Agent can reach: filesystem, network, environment, credentials, processes, and isolation. `unknown` means the runtime or provider cannot prove that part during inspection. It does not mean restricted or denied. The snapshot describes the inspected context. It is not an enforcement decision or proof of safety.
`--json` gives the structured contract at `config.driver.executionAuthority`. Use `--url` when Vite is not on `http://localhost:5173`.
With more than one Agent, `--agent` is required.
`agent info` reads from the guarded Agent Dev Loop endpoint of `hubAgent()`.

`agent info`, `agent dev`, and `channels replay` send a private token to this endpoint. The dev server stores the token with user-only permissions outside the served project, and the CLI reads it locally. The discovery request needs no token. It returns Agent names, aliases, trigger names, the server root, and the token server ID, but not the token. Without the token, the endpoint rejects Agent inspection, messages, Capability CLI calls, Workspace commands, and Channel replay, also on a server exposed with `--host`. Run these commands on the dev server's machine.

## Cancel an Agent Invocation

Start the Vite + Nitro dev server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

`hubAgent()` adds a guarded `/__vitehub/agent/invocations/dev` endpoint to the dev server. It forwards the request into the Nitro dev environment, where the Agent Definitions and `invocations` journals are the same objects that run the app's Invocations. So the cancel reaches the running Invocation with any store, including `createMemoryAgentInvocationStore()`. The endpoint accepts only local hosts and same-origin requests. Use `--url`, `--server`, or `VITEHUB_DEV_SERVER_URL` when Vite is not on `http://localhost:5173`, and `--timeout` to change the timeout.

Nuxt runs Nitro outside the Vite process, and plain Vite has no Nitro. There the endpoint returns `501`, and the command prints the reason and exits with status 1.

| Output | Meaning | Exit status |
| --- | --- | --- |
| `cancel requested` | A run in the Nitro runtime got an abort signal. Its final journal state shows whether it stopped. | 0 |
| `cancel request recorded; execution stop is unconfirmed` | The journal kept the request for a current or future owner. A crashed owner sees it only after execution recovery. | 0 |
| `cancel requested, not enforced by <driver>` | The Driver cannot enforce an abort. Delivery does not confirm that its owner got the request. | 0 |
| `already <status>` | The Invocation already finished. | 0 for `cancelled`; 1 for `completed` or `failed` |
| `not found` | The journal has no Invocation with this id. | 1 |

`--json` prints the `AgentInvocationCancelResult` from `invocations.cancel(id)`.

### Inspect and cancel on a deployed app

Pass the deployed app URL with `--url` to list, show, follow, or cancel Invocations through its [Console](/docs/development/console). The Console must be on, and `cancel` also needs `invoke: true`, like the Console cancel button. The command does not load the project config, so a local config error cannot stop it.

```bash [Terminal]
export VITEHUB_CONSOLE_COOKIE='__Secure-vitehub_console.session_token=...'
pnpm vitehub agent invocations list --url https://app.example.com --status running
pnpm vitehub agent invocations show ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
```

Each command posts to `/_vitehub/rpc/__call` under the app URL, and the Console access policy checks it like a page request. Set the credentials the policy accepts:

| Variable | Value |
| --- | --- |
| `VITEHUB_CONSOLE_COOKIE` | A `Cookie` header value from a signed-in Console session. With Console Auth, copy the `vitehub_console.session_token` cookie, which has the `__Secure-` prefix on HTTPS. |
| `VITEHUB_CONSOLE_AUTHORIZATION` | An `Authorization` header value, for example the Bearer token that a `console.authorize` function checks. |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token for `auth: { provider: 'cloudflare-access' }`. |

A URL means the Console when its host is not `localhost`, or its path contains `/_vitehub`, such as a Console page URL from the browser or `http://localhost:3000/_vitehub` for a local production build. Other localhost URLs mean the dev server. Remote URLs must use HTTPS, without credentials, a query, or a fragment. The command does not follow redirects. A `401` or a redirect reports a Console authentication failure.

The Console has no status filter, so `list --status` reads pages until it has `--limit` matches (default 50). `tail` asks only for observations after the last one it printed. Cancel outcomes and exit statuses are the same as in development.

## Talk to an Agent during development

Start the dev server, then attach the Agent Dev Loop from another terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

Pass a message or `--prompt` for one invocation, or neither for an interactive session.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support --prompt "/summary"
pnpm vitehub agent dev --agent support -p "/summary"
```

Use `--payload` for event input that usually comes from a Channel, route, webhook, or app transport.
The file can be anywhere. `server/agents/<agent>/dev.payload.json` keeps it next to the Agent Definition, outside production behavior.
It must hold one JSON object shaped for the selected Agent Trigger.
For non-chat triggers, pass `--trigger` and shape the file for that trigger, not for Agent Invocation Context Values.

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

Use `--cli` when a Capability (a feature added to the Agent) declares its own CLI.
Everything after `--` is the Capability CLI command.
The Agent Dev Loop has these commands by default, also for provider-backed Agents. `defineAgent({ cli: { capabilities: false } })` hides them.
During Agent runs, ViteHub shows operation tool calls as command lines, such as `api listCustomers --query '{"status":"active"}'`, not as raw input objects.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

The output shows the payload file path before the Agent Invocation starts.
In interactive mode, type a message or command such as `/summary`.

```txt [Output]
Loaded payload: /Users/acme/app/server/agents/support/dev.payload.json
Connected to support at http://localhost:5173
> /summary
```

Start input with `!` to run a shell command in the Agent's Workspace (its file system).
The Agent must declare a writable Workspace.
ViteHub runs the command in a Workspace Session and commits successful changes to the Workspace Store.

```bash [Terminal]
pnpm vitehub agent dev --agent support "!pnpm test"
pnpm vitehub agent dev --url http://localhost:5173 --timeout 180000 support !pnpm test --filter api
```

Put Agent Dev Loop options before the `!` command. Flags after `!` go to the Workspace command.
In interactive mode, `!` input skips the Agent for that turn.
Use normal messages for the Agent, `!` for Workspace shell work, and `--cli` for Capability commands.

```txt [Output]
Connected to support at http://localhost:5173
> !pnpm test
```

## Run Workspace commands during development

Use `vitehub workspace dev` to run a command in a Workspace without an Agent.
Start the dev server, then run it in another terminal.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
pnpm vitehub workspace dev --timeout 180000 docs exec "npm run lint"
pnpm vitehub workspace dev --path guides --path examples docs exec pnpm test
```

The command runs through the Workspace dev endpoint of `hubWorkspace()` on the Compatible Vite Development Server.
ViteHub creates a Workspace Session, runs the command, prints stdout and stderr, and commits the session when the command succeeds.
Put options before the Workspace target, and `exec` before one-shot command args.
Repeat `--path <path>` to load only those paths into the session.
Without a command in an interactive terminal, the CLI opens a prompt for repeated commands.

```txt [Output]
Connected to docs at http://localhost:5173
> pnpm test
```

## Read Workspace history during development

`vitehub workspace history`, `refs`, and `show` read a Workspace's [retained history](/docs/workspace/server-api#retained-folder-history): its refs, such as `draft` and `published`, and the revisions on each. Run them next to the dev server, or pass `--url <origin>` for a deployed app. They only read, and never commit or move a ref.

```bash [Terminal]
pnpm vitehub workspace history content
pnpm vitehub workspace history content --ref draft --limit 10
pnpm vitehub workspace refs content
pnpm vitehub workspace show content draft
pnpm vitehub workspace show content published posts/hello.md
pnpm vitehub workspace show content 9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a posts/hello.md
```

```txt [Output]
REVISION                                                          REF        CREATED AT                AUTHOR  FILES  MESSAGE
bc4cf2341f4244c405de80d58ff6b53b5855b27e22dfb9b61567c9cfc44a4f3d  draft      2026-10-15T12:12:47.744Z  maxi    2      Edit hello
9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a  published  2026-10-15T12:12:47.733Z  editor  1      Publish hello
c08f4415a5303b77a6a0e58436b885215950ed298e3e6cebbc85c18f2b97edb9  draft      2026-10-15T12:12:47.727Z  maxi    2      Save hello
8d104bde6b19e80361256ab8f6f0bfee81c2756210c864c5db1ea95a25e40d0f  main       2026-10-15T12:12:47.716Z  -       1      Start content
```

- `history <workspace>` lists revisions newest first. Without `--ref`, it merges all refs and shows the newest `--limit` revisions (default `20`, at most `100`). With `--ref <ref>`, it lists one ref and prints the `--cursor` of the next page.
- `refs <workspace>` lists each ref with its head revision.
- `show <workspace> <ref|revision> [path]` takes a ref name or full revision id. A ref name wins when both match. Without a path, it prints the revision and its files with size, media type, and SHA-256 digest. With a file path, it prints the file as it was then, so you can redirect it. A binary file prints a notice instead, and `--json` returns its bytes as `base64`. With a directory path, it lists the files under it.

`AUTHOR` is the revision `metadata.author`, or `-`. Times are ISO 8601 UTC. Blob + Database revision ids are SHA-256 digests of the revision manifest. Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. With `--json`, the CLI prints revision objects with `id`, `ref`, `parentId`, `createdAt`, `message`, `metadata`, `author`, `files`, and `bytes`, and `show` returns content as `utf8` text or `base64` bytes. Errors go to stderr, or to the JSON body with `--json`, with exit status 1.

A Workspace whose Store keeps no revisions fails with `WORKSPACE_R0069` and names the [Blob + Database Store](/docs/workspace/configure#blob-database-store), which keeps refs and revisions.

The commands are the `workspace.history`, `workspace.refs`, and `workspace.show` [operations](/docs/development/operations) of the Workspaces section. They run in the app's Nitro runtime, so they work on the dev server and on a deployed app. All three read, so `console.authorize` grants them with `workspaces` or `workspaces:read`.

## Preview provisioning

Use `--dry-run` before you create provider resources.
Provision never deletes or changes existing resources. It writes non-secret ids only when a real run applies actions.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Unknown ViteHub CLI namespace` | The package plugin is missing or off. | Add the package's `hubX()` plugin to `vite.config.ts`. |
| `Unknown Definition kind` | No active package has that kind. | Use a kind from the printed list, or turn on the package. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Provision dry-run reports no actions | A package plan skipped the provider lookup, because its read credentials are missing. | Set the provider credentials. `--dry-run` still blocks `apply()`. |
| Vercel Provision reports no resources for Blob | `VERCEL_PROJECT_ID` is missing, or the Blob store is not `vercel-blob`. | Set the project id and the Vercel Blob driver, then run again. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` turns off the eval runner. | Turn the option back on for local development. |
| Agent eval times out | The eval case, model call, or provider run takes longer than `agent.eval.testTimeout`. | Raise `agent.eval.testTimeout` in `vite.config.ts` or make the case smaller. |
| Vite config fails to load a ViteHub plugin import | A new npm project loads `vite.config.ts` as CommonJS, but ViteHub packages are ESM-only. | Set `"type": "module"` in `package.json` or rename the config to `vite.config.mts`. |
| `No Compatible Vite Development Server found` | The dev server is not running, or `--url` has the wrong port. | Start Vite, then pass the dev server URL. |
| `CLI_R0005` from an operation command | No dev server wrote `.vitehub/dev-server.json`, and `VITEHUB_DEV_SERVER_URL` is not set. | Start `vite dev` in this project, or pass `--url`. |
| `INTERNAL_R0025` from an operation command | The server at the URL runs another project. | Start `vite dev` in this project, or pass the right `--url`. |
| `INTERNAL_R0024` from an operation command | The command could not reach the app, or the app asked for sign-in. | Start `vite dev`, or pass `--url` and set `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE`, or the Cloudflare Access variables. |
| `vitehub schedule run` fails with `SCHEDULE_DEFINITION_NOT_FOUND` | The Definition does not set `manual: true`, is not found, or the Console did not install it because `console.invoke` is off. | Set `manual: true`, and keep `console.invoke` on. |
| `vitehub schedule run` fails with `SCHEDULE_MANUAL_RUN_DISABLED` | The Definition exists but does not set `manual: true`. | Set `manual: true` in `defineSchedule()`. |
| `vitehub schedule run --at` fails with `SCHEDULE_INVALID_SCHEDULED_AT` | The time has no time zone or no time, or the day does not exist. | Pass an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00Z`. |
| `Unknown Workspace Dev target` | The dev server did not find that Workspace. | Check the Workspace Definition name and that `hubWorkspace()` is active. |
| `Agent Dev Loop command requires workspace.mode: "write"` | A `!` command targeted an Agent without a writable Workspace. | Give the Agent `workspace: { mode: 'write' }`, or send a normal message. |
| Agent Dev Loop request times out | A streamed invocation sent no events before the inactivity timeout, or a Capability CLI or Workspace command passed its deadline. | Pass `--timeout <ms>`, or look at the stalled work. |
| `Agent Dev Loop payload file must contain a JSON object` | The `--payload` file is not a JSON object. | Put one object shaped for the selected Agent Trigger in the file. |

## Next steps

- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.

## Run Workflows in development

Turn on `hubWorkflow()` and start the dev server.

```bash [Terminal]
pnpm vitehub workflow start welcome --payload '{"name":"Ada"}'
pnpm vitehub workflow get <runId>
pnpm vitehub workflow cancel <runId> --yes
pnpm vitehub workflow resume <token> --payload '{"approved":true}'
```

The commands come from the `workflow.start`, `workflow.get`, `workflow.cancel`, and `workflow.resume` [operations](/docs/development/operations). They call the app's Console RPC, so app and CLI runs share state. `--url <origin>` calls a deployed app that serves it. The payload is a JSON value. `--input '{"workflow":"welcome","payload":{...}}'` or `--input @file.json` passes the whole input. `cancel` asks for confirmation unless you pass `--yes`. All commands take `--json`, `--url`, and `--timeout`. A run this runtime did not start needs `--workflow <name>` for `get` and `cancel`. A `console.authorize` grant of `workflows` allows all four. `workflows:read` allows only `get`.

Inline runs can be read for five minutes. Inline cancel, Cloudflare cancel and resume, and OpenWorkflow resume return unsupported-operation errors. OpenWorkflow starts queue work and need a worker to run it. Resume uses an opaque hook token, not a run ID or signal name. Workflow inspection lists Definitions. This CLI has no run list, replay, or Console run view.
