---
title: Task, Schedule, and Workflow commands
description: Run Nitro tasks, run and inspect Schedules, and start, read, and cancel Workflow runs on the dev server or a deployed app with the vitehub CLI.
navigation.title: Tasks, Schedules, Workflows
navigation.order: 7
navigation.group: Commands
icon: i-lucide-timer
---

These commands run app code in the Nitro runtime of the dev server, or of a deployed app with `--url`. On a deployment, the commands that run app code need `console: { invoke: true }`. See [Run any operation](/docs/cli/operations#run-any-operation).

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
import { useDatabase } from 'vite-hub/database'
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

`task list` and `task run` are the `task.list` and `task.run` [operations](/docs/console/operations) in the `tasks` section. They exist when the app has task files or declares `nitro.tasks`. A generated Nitro plugin gives them Nitro's registry, so they also work on a deployment with `--url` and the Console credentials (`task run` needs `console.invoke`). `task run` is `destructive`, so it asks for `--yes`. The `tasks` section has no Console page. Grant it in `console.authorize` with `sections: ['tasks']`, or `'tasks:read'` for listing only.

> [!WARNING]
> A task can change anything the app can. Give `tasks` only to people who may run a seed or a backfill.

`vitehub task` does not support Nuxt, because Nuxt runs its own Nitro and scans `server/tasks` itself when `nitro.experimental.tasks` is on.

Set `nitro: { experimental: { tasks: false } }` to turn tasks off. A task that `nitro.tasks` declares keeps its handler and description.

## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition that sets `manual: true`, and prints the run status, duration, run id, and scheduled time. `--json` prints the run record. A failed run still exits with `0`, so read `status` or `error`. An unknown name fails with `SCHEDULE_DEFINITION_NOT_FOUND` (`404`). A definition without `manual: true` fails with `SCHEDULE_MANUAL_RUN_DISABLED` (`403`).

```bash [Terminal]
pnpm vitehub schedule run sync
pnpm vitehub schedule run sync --at 2026-01-31T23:59:00Z
pnpm vitehub schedule run sync --url https://app.example.com
```

`--at` runs the definition as if its cron fired at that time, without checking the cron. The handler gets it as `scheduledAt`, and `vitehub schedule runs <name>` lists the run under it. Use it to test code that depends on the fire time, such as a job near midnight or on a month's last day. The value is an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00+01:00`. No time zone, a date only, or a day that does not exist (`2026-02-30`) fails with `SCHEDULE_INVALID_SCHEDULED_AT` (`400`), and nothing runs.

`schedule run` is the `schedule.run` [operation](/docs/console/operations) of the Schedules section. Without `--url`, the dev server runs the definition in its Nitro runtime, with the app's Nitro plugins and dev bindings, and the run shows in `vitehub schedule runs <name>`. With `--url`, it calls the deployment with the credentials in [Call a deployed app](/docs/cli/operations#call-a-deployed-app). The deployment runs only definitions that the [Console](/docs/console) installed with `invoke: true`, which is on in development and off in a production build.

A CI job needs no Console login. Make a key pair with `vitehub secret console-key ci`, set `VITEHUB_CONSOLE_KEY_CI` on the app with `console: true`, and set `VITEHUB_CONSOLE_PRIVATE_KEY_CI` as a secret of the job. `vitehub schedule run <name> --url <origin>` then [signs the call](/docs/console/signed-requests), the same as every other command with `--url`.

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

The commands are generated from the `workflow.start`, `workflow.get`, `workflow.cancel`, and `workflow.resume` [operations](/docs/console/operations). They call the Console RPC of the running app, so app and CLI runs share state, and `--url <origin>` calls a deployed app that serves the Console RPC. The argument after the Workflow name or token is the payload, a JSON value; `--input '{"workflow":"welcome","payload":{...}}'` or `--input @file.json` passes the whole input. `cancel` and `runs clear` ask for confirmation unless you pass `--yes`. All commands accept `--json`, `--url`, and `--timeout`. A run that this runtime did not start needs `--workflow <name>` for `get` and `cancel`. A `console.authorize` grant of `workflows` allows them all; `workflows:read` allows only `get`, `runs list`, and `runs show`.

Inline runs can be read with `get` for five minutes. Inline cancellation, Cloudflare cancellation and resume, and OpenWorkflow resume return unsupported-operation errors. OpenWorkflow starts enqueue work and require a worker to execute it. Resume uses an opaque hook token, not a run ID or signal name.

### Inspect runs in development

`vite dev` records every inline run: the runs that `vitehub workflow start`, the Console, and app code start. `vitehub workflow runs list` lists them newest first, with their status and step count. Filter with `--workflow <name>`, `--status queued|running|completed|failed`, and `--limit <n>`. `vitehub workflow runs show <runId>` prints the run with each step, its status and times, the error of a failed step, and the result of the run. Add `--json` for the step outputs. Credentials in results, outputs, and error messages are redacted. `vitehub workflow runs clear --yes` removes all recorded runs and prints how many it removed, so a test or an agent can start from an empty history without a restart. It does not cancel active runs and does not change what `get` returns.

The history lives in the memory of the dev server. It keeps the newest 200 runs and is empty after a restart or `runs clear`. It records the steps of a folder Workflow, the numbered files that run through `steps`. Inline runs do not retry a failed step, so each step runs once. The history records inline runs only: a run that a Cloudflare Workflow binding, OpenWorkflow storage, or a native Vercel Workflow starts is not in it. Only the dev Nitro plugin imports the history code, so a build does not include it and never records runs. On a deployment, `runs list`, `runs show`, and `runs clear` fail with `WORKFLOW_RUNS_UNAVAILABLE` (`409`). Read one deployed run with `vitehub workflow get <runId> --workflow <name>`. An id that the history does not have fails with `WORKFLOW_RUN_NOT_FOUND` (`404`).
