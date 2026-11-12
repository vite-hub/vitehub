---
title: Server Primitive commands
description: Read and write blobs, KV keys, Database tables, Content, Schedules, Workflows, and Workspaces of a running or deployed app from the terminal.
navigation.order: 3
navigation.group: Commands
icon: i-lucide-boxes
---

Each Server Primitive package adds its own commands. A namespace shows in `vitehub --help` only when its package is on.

## Read and write blobs

Start the dev server, then run `vitehub blob` in another terminal. Each command runs a `blob.*` [operation](/docs/development/operations) of the app, so it uses the app's blobs. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](/docs/cli/inspect#run-any-operation).

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/ --limit 20
pnpm vitehub blob head avatars/ada.png
pnpm vitehub blob get avatars/ada.png --output ./ada.png
pnpm vitehub blob get reports/2026.csv > report.csv
pnpm vitehub blob put avatars/ada.png ./ada.png --content-type image/png
pnpm vitehub blob delete avatars/ada.png
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

The operations are `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.del`, `blob.media`, and `blob.variants`, in the `blob` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `blob` section. `blob.put` writes and `blob.del` is destructive. `vitehub blob delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console Blob page uses the same operations.

## Inspect the Email development outbox

When the dev server has Email on, read the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Add `--json` for machine-readable output. The outbox exists only in `vite dev` and empties when the server restarts. `vitehub email preview <template>` renders a `server/emails` template without sending it, in your terminal, with no server.

The commands run `email.outbox-list`, `email.outbox-show`, and `email.outbox-clear` in the `email` Console section, so you need access to that section. `email.outbox-clear` is destructive: `vitehub email outbox clear` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The `email.preview` operation renders a template through the same RPC. The written `vitehub email preview` command renders in your terminal without a server. The generated commands `vitehub email outbox list`, `outbox show`, and `outbox clear` print JSON.

## Read and reset Rate Limit counters

Read or reset one key's counter of a Rate Limit from `requireRateLimit()`:

```bash [Terminal]
pnpm vitehub rate-limit peek <id> <key>
pnpm vitehub rate-limit reset <id> <key> [--yes]
```

`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, such as a client IP or user ID. Put `--` before a key that starts with a dash. Both commands take `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, they call this project's dev server. With `--url https://app.example.com`, they call a deployed app with the [Console](/docs/development/console) on, and sign with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.

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
VITEHUB_SECRET=... pnpm vitehub secret derive myapp:webhooks
pnpm vitehub secret console-key ci
```

`secret generate` prints 32 random bytes as base64 for [`VITEHUB_SECRET`](/docs/env/app-secret). `secret derive <purpose>` prints `deriveSecret(purpose)` for the `VITEHUB_SECRET` (or `NUXT_APP_SECRET`) in the shell. `secret console-key [name]` prints a new Ed25519 key pair for [signed Console requests](/docs/development/console#sign-console-requests): the `VITEHUB_CONSOLE_KEY_<NAME>` line for the app and the `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` line for the CLI. The name defaults to `CLI`. None of them loads the project.

## Manage Database migrations

The Database commands refresh the Database Definitions, then run Drizzle Kit. When every Database is named, ViteHub runs once per generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database generate --name add-audit-log
pnpm vitehub database generate --custom --name backfill-state
pnpm vitehub database generate --custom --schema-snapshot --name move-tables
pnpm vitehub database migrate
pnpm vitehub database up
```

`database up` converts each migrations folder of Drizzle Kit 0.x, with `meta/_journal.json`, to one folder per migration, as Drizzle Kit 1.0 writes them. `database generate` and `database migrate` refuse a 0.x folder with `DATABASE_MIGRATIONS_OLD_LAYOUT`.

`database generate` forwards Drizzle Kit arguments, supports `--name <name>` for a migration name, and uses `--custom` to create an empty custom migration. Drizzle Kit copies the previous snapshot into a custom migration, for SQL that changes only data. When the SQL changes the tables to the current Database Definitions, add `--schema-snapshot`: the migration then gets the snapshot of those Definitions, so the next `database generate` has nothing to add. `database migrate` accepts forwarded Drizzle Kit migration arguments.

## Export a Database

`database export` writes a SQL dump of each database, with no build. It reads the local SQLite file by default. `--remote` reads Cloudflare D1 (through the Cloudflare API), D1 HTTP, remote libSQL, or Postgres (through `pg_dump`).

```bash [Terminal]
pnpm vitehub database export
pnpm vitehub database export --remote --stage production --output backups/database.sql
```

| Option | Description |
| --- | --- |
| `--remote` | Read the remote database. Needed for a database that is not a local file. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Export only this database. |
| `--output <file>` | Write this file. Defaults to `.vitehub/exports/database/<name>-<local\|remote>-<time>.sql`. |

See [Export a database](/docs/database/configure#export-a-database) for each driver and the dump format.

## Browse Database tables

`database tables` and `database rows` run `databases.tables` and `databases.browse`, the [operations](/docs/development/operations) of the Console Databases section. They read the running app's Database Definitions, so they work on any driver without a Drizzle Kit config. They never write.

```bash [Terminal]
pnpm vitehub database tables
pnpm vitehub database rows users --limit 20 --sort email --direction desc
pnpm vitehub database rows users --search ada --json
pnpm vitehub database rows users --database analytics --offset 20 --url https://app.example.com
```

`database rows` reads at most 100 rows at a time and cuts cells at 32 KiB. `--offset` pages, `--sort <column>` and `--direction asc|desc` sort, and `--search <text>` matches any column. Without a table, it reads the tables only. A table that does not exist fails with `CONSOLE_NOT_FOUND`. `--database` picks a named database. Access needs the `databases` section, and `databases:read` is enough.

## Read and write KV keys

Start the dev server, then run `vitehub kv` in another terminal. Each command runs a `kv.*` [operation](/docs/development/operations) of the app, so it uses the app's keys. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](/docs/cli/inspect#run-any-operation).

```bash [Terminal]
pnpm vitehub kv list --prefix users: --limit 20
pnpm vitehub kv get settings
pnpm vitehub kv has settings
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv set session:42 active --ttl 3600
pnpm vitehub kv set template @./fixtures/template.txt
pnpm vitehub kv delete settings
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

The operations are `kv.list`, `kv.get`, `kv.has`, `kv.set`, and `kv.del`, in the `kv` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `kv` section. `kv.del` is destructive: `vitehub kv delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console KV page uses the same operations.


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

## Check and move translations

`vitehub i18n status` reads `t`, `<Trans>`, `plural`, `select`, and `msg` in the code, and compares them with the records in `locales/<locale>/`. It prints, per locale, the number of messages, translated messages, missing messages, and unused records. It needs no dev server and changes no file.

```bash [Terminal]
pnpm vitehub i18n status --json
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po
pnpm vitehub i18n prune --yes
```

`export` writes a PO file for Poedit or a translation service. `import` saves its translations as records. `prune` deletes the records of messages that the code no longer has. Without `--yes`, it only lists them. Read [Translate your first page](/docs/i18n/get-started) for the full flow.

## Run app tasks

A task is a [Nitro task](https://nitro.build/docs/tasks): a file in `server/tasks/` that default-exports `defineTask()`. Use tasks for seeds, backfills, data repair, and one-off admin jobs. `vitehub()` registers each file and turns on Nitro tasks, so you do not set `nitro.serverDir` or `nitro.experimental.tasks`. The task name is the path with `/` replaced by `:`, so `server/tasks/db/seed.ts` is `db:seed`.

This seed task adds a row to the `notes` table of the default Database:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      title: text('title').notNull(),
    }),
  },
})
```

```ts [server/tasks/db/seed.ts]
import { useDatabase } from 'vite-hub/database/drizzle'
import { defineTask } from 'nitro/task'

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
pnpm vitehub task run db:seed '{"title":"First note"}' --yes
pnpm vitehub task run db:seed '{"title":"First note","count":3}' --json --yes
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

- The argument after the task name is the payload, a JSON object. Without it the payload is `{}`. `--input '{"name":"db:seed","payload":{...}}'` or `--input @file.json` passes the whole input.
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

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. Without `--url`, it calls this project's dev server (see [Run any operation](/docs/cli/inspect#run-any-operation)). With `--url`, it calls a deployed app with the Console on, using the credentials from [the table below](/docs/cli/agents#inspect-and-cancel-on-a-deployed-app). See [Content CLI](/docs/content/cli) for each command's output.

## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition that sets `manual: true`, and prints the run status, duration, run id, and scheduled time. `--json` prints the run record. A failed run still exits with `0`, so read `status` or `error`. An unknown name fails with `SCHEDULE_DEFINITION_NOT_FOUND` (`404`). A definition without `manual: true` fails with `SCHEDULE_MANUAL_RUN_DISABLED` (`403`).

```bash [Terminal]
pnpm vitehub schedule run sync
pnpm vitehub schedule run sync --at 2026-01-31T23:59:00Z
pnpm vitehub schedule run sync --url https://app.example.com
```

`--at` runs the definition as if its cron fired at that time, without checking the cron. The handler gets it as `scheduledAt`, and `vitehub schedule runs <name>` lists the run under it. Use it to test code that depends on the fire time, such as a job near midnight or on a month's last day. The value is an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00+01:00`. No time zone, a date only, or a day that does not exist (`2026-02-30`) fails with `SCHEDULE_INVALID_SCHEDULED_AT` (`400`), and nothing runs.

`schedule run` is the `schedule.run` [operation](/docs/development/operations) of the Schedules section. Without `--url`, the dev server runs the definition in its Nitro runtime, with the app's Nitro plugins and dev bindings, and the run shows in `vitehub schedule runs <name>`. With `--url`, it calls the deployment with the [credentials below](/docs/cli/agents#inspect-and-cancel-on-a-deployed-app). The deployment runs only definitions that the [Console](/docs/development/console) installed with `invoke: true`, which is on in development and off in a production build.

A CI job needs no Console login. Make a key pair with `vitehub secret console-key ci`, set `VITEHUB_CONSOLE_KEY_CI` on the app with `console: true`, and set `VITEHUB_CONSOLE_PRIVATE_KEY_CI` as a secret of the job. `vitehub schedule run <name> --url <origin>` then [signs the call](/docs/development/console#sign-console-requests), the same as every other command with `--url`.

The Console Schedules page runs the same operation. A read-only grant (`"schedules:read"`) can list runs but cannot run a Schedule.

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

`list`, `start`, and `cancel` work on the Schedules that code starts with [`startSchedule()`](/docs/schedule/server-api#start-a-schedule-from-code). The Definition has no `cron`. `start` takes `--at` for one run, or `--cron` and `--time-zone` for a repeating one. To pass a payload, give the whole input as JSON with `--input`.

```bash [Terminal]
pnpm vitehub schedule start reminder --at 2026-11-08T09:00:00Z
pnpm vitehub schedule start reminder --input '{"name":"reminder","cron":"0 9 * * 1-5","timeZone":"Europe/Madrid","payload":{"text":"Stand-up"}}'
pnpm vitehub schedule list
pnpm vitehub schedule runs sched_mh1x2y3z_ab12cd34
pnpm vitehub schedule cancel sched_mh1x2y3z_ab12cd34 --yes
```

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. `runs` takes `--limit <n>`. Errors go to stderr, or to the JSON body with `--json`. `schedule.runs` and `schedule.attempts` are `read` operations of the Schedules section.

The output redacts URLs with credentials, bearer tokens, and secret assignments in error messages. When the store cannot list the full history, the command fails with `SCHEDULE_HISTORY_INCOMPLETE` (`503`). An unknown run id fails with `SCHEDULE_RUN_NOT_FOUND` (`404`).

## Run Workflows in development

Turn on `hubWorkflow()` and start the dev server.

```bash [Terminal]
pnpm vitehub workflow start welcome '{"name":"Ada"}'
pnpm vitehub workflow get <runId>
pnpm vitehub workflow cancel <runId> --yes
pnpm vitehub workflow resume <token> '{"approved":true}'
pnpm vitehub workflow runs list --status failed
pnpm vitehub workflow runs show <runId>
pnpm vitehub workflow runs clear --yes
```

The commands are generated from the `workflow.start`, `workflow.get`, `workflow.cancel`, and `workflow.resume` [operations](/docs/development/operations). They call the Console RPC of the running app, so app and CLI runs share state, and `--url <origin>` calls a deployed app that serves the Console RPC. The argument after the Workflow name or token is the payload, a JSON value; `--input '{"workflow":"welcome","payload":{...}}'` or `--input @file.json` passes the whole input. `cancel` and `runs clear` ask for confirmation unless you pass `--yes`. All commands accept `--json`, `--url`, and `--timeout`. A run that this runtime did not start needs `--workflow <name>` for `get` and `cancel`. A `console.authorize` grant of `workflows` allows them all; `workflows:read` allows only `get`, `runs list`, and `runs show`.

Inline runs can be read with `get` for five minutes. Inline cancellation, Cloudflare cancellation and resume, and OpenWorkflow resume return unsupported-operation errors. OpenWorkflow starts enqueue work and require a worker to execute it. Resume uses an opaque hook token, not a run ID or signal name.

### Inspect runs in development

`vite dev` records every inline run: the runs that `vitehub workflow start`, the Console, and app code start. `vitehub workflow runs list` lists them newest first, with their status and step count. Filter with `--workflow <name>`, `--status queued|running|completed|failed`, and `--limit <n>`. `vitehub workflow runs show <runId>` prints the run with each step, its status and times, the error of a failed step, and the result of the run. Add `--json` for the step outputs. Credentials in results, outputs, and error messages are redacted. `vitehub workflow runs clear --yes` removes all recorded runs and prints how many it removed, so a test or an agent can start from an empty history without a restart. It does not cancel active runs and does not change what `get` returns.

The history lives in the memory of the dev server. It keeps the newest 200 runs and is empty after a restart or `runs clear`. It records the steps of a folder Workflow, the numbered files that run through `steps`. Inline runs do not retry a failed step, so each step runs once. The history records inline runs only: a run that a Cloudflare Workflow binding, OpenWorkflow storage, or a native Vercel Workflow starts is not in it. Only the dev Nitro plugin imports the history code, so a build does not include it and never records runs. On a deployment, `runs list`, `runs show`, and `runs clear` fail with `WORKFLOW_RUNS_UNAVAILABLE` (`409`). Read one deployed run with `vitehub workflow get <runId> --workflow <name>`. An id that the history does not have fails with `WORKFLOW_RUN_NOT_FOUND` (`404`).

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

## Work on Workspace files in a local folder

`vitehub pull` and `vitehub push` keep a folder of the project in sync with one ref of a Workspace, as `git pull` and `git push` do with a branch. Edit the files in your editor, and edit the same ref in the Console. The first pull names the folder and the ref and writes `vitehub.lock`; commit that file. See [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder).

```bash [Terminal]
pnpm vitehub pull site --dir content --ref draft --url https://docs.example.com
pnpm vitehub pull --dry-run
pnpm vitehub push --message "Fix the install guide"
```

Run `pnpm vitehub hooks install` once to check for conflicts before each commit and to push the checkout folders when you push the default branch. A push of another branch leaves the remote ref alone, so work in progress does not reach the shared draft. The Workspace push updates `vitehub.lock`, and Git cannot add it to a push that already started, so the hook stops that Git push. Commit `vitehub.lock` and any pulled files, then run `git push` again. Skip the hooks for one Git command with `--no-verify`.

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
