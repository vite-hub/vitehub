---
title: Task, Schedule, and Workflow commands
description: Run Nitro tasks, run and inspect Schedules, and start, read, and cancel Workflow runs on the dev server or a deployed app with the vitehub CLI.
navigation.title: Tasks, Schedules, Workflows
navigation.order: 7
navigation.group: Commands
icon: i-lucide-timer
---

These commands run your app's background code on demand: a seed, a Schedule you want to test now, or a Workflow. They run on the dev server, or on a deployed app with `--url`, where the commands that run app code need `console: { invoke: true }`. See [Run any operation](/docs/cli/operations#run-any-operation).

## Run app tasks

A **task** is a [Nitro task](https://nitro.build/docs/tasks): a file in `server/tasks/` that default-exports `defineTask()`. Use one for a seed, a backfill, a data repair, or a one-off admin job. `vitehub()` registers each file and turns Nitro tasks on, so you set neither `nitro.serverDir` nor `nitro.experimental.tasks`. The task name is the path with `/` replaced by `:`, so `server/tasks/db/seed.ts` is `db:seed`.

This seed task adds a row to the `notes` table of the default Database:

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

Start the dev server, then run the task in another terminal. It runs inside that server, so `useDatabase()`, `kv`, `blob`, and `env` get the same bindings as a request.

```bash [Terminal]
pnpm vitehub task list
pnpm vitehub task run db:seed '{"title":"First note"}' --json --yes
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

The argument after the task name is the payload, a JSON object that defaults to `{}`, and `--input @file.json` passes the whole input. `task run` asks for `--yes`. Nitro runs one instance of a task name at a time per server, so a second run while the first is active gets the first run's result.

| Error | Cause |
| --- | --- |
| `TASK_FAILED` | The task threw. The message goes to stderr, or to `{ "error": { "code", "message", "fix" } }` with `--json`, and the server log shows the stack. |
| `TASK_NOT_FOUND` | No task has that name. |
| `TASK_NOT_IMPLEMENTED` | The task file has no `run()`. |

`task list` asks the running app, so it also shows tasks that `nitro.tasks` declares, while `vitehub inspect definitions --kind task` lists `server/tasks/` with no server. On a deployment, `task run` needs `console.invoke`. The `tasks` section has no Console page, so grant it in `console.authorize` with `sections: ['tasks']`, or `'tasks:read'` to list only. `nitro: { experimental: { tasks: false } }` turns tasks off, but a task that `nitro.tasks` declares keeps its handler.

::warning
A task can change anything the app can. Give `tasks` only to people who may run a seed or a backfill.
::

::note
`vitehub task` does not support Nuxt, because Nuxt runs its own Nitro and scans `server/tasks` itself when `nitro.experimental.tasks` is on.
::

## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition now, so you can test it without waiting for its cron. The Definition must set `manual: true`.

```bash [Terminal]
pnpm vitehub schedule run sync
pnpm vitehub schedule run sync --at 2026-01-31T23:59:00Z
pnpm vitehub schedule run sync --url https://app.example.com
```

It prints the run status, duration, run id, and scheduled time, or the run record with `--json`. A failed run still exits with `0`, so read `status` or `error`. On the dev server, the run shows in `vitehub schedule runs <name>`.

`--at` runs the Definition as if its cron fired at that time, and the handler gets it as `scheduledAt`, so you can test a job near midnight or on a month's last day. Give an ISO 8601 date-time with `Z` or an offset.

| Error | Cause |
| --- | --- |
| `SCHEDULE_DEFINITION_NOT_FOUND` (`404`) | No Definition has that name, or the deployment did not install it. |
| `SCHEDULE_MANUAL_RUN_DISABLED` (`403`) | The Definition does not set `manual: true`. |
| `SCHEDULE_INVALID_SCHEDULED_AT` (`400`) | `--at` has no time zone, is a date only, or names a day that does not exist (`2026-02-30`). Nothing runs. |

A deployment runs only Definitions that the [Console](/docs/console) installed with `invoke: true`, which is on in development and off in a production build. A read-only grant (`"schedules:read"`) can list runs but not run a Schedule.

::tip
A CI job needs no Console login. Make a key pair with `vitehub secret console-key ci`, set `VITEHUB_CONSOLE_KEY_CI` on the app with `console: true`, and set `VITEHUB_CONSOLE_PRIVATE_KEY_CI` as a secret of the job. `vitehub schedule run <name> --url <origin>` then [signs the call](/docs/console/signed-requests).
::

## Run and inspect Schedules

`runs` and `attempts` show the runs the app recorded, manual runs and Process Runtime runs alike, from the dev server's Schedule Run store.

```bash [Terminal]
pnpm vitehub schedule runs digest --limit 5
pnpm vitehub schedule runs digest --json
pnpm vitehub schedule attempts srun_static_digest_2026-05-22T07:00:00.000Z
```

```txt [Output]
RUN                                          STATUS     SCHEDULED AT              ATTEMPTS  ERROR
srun_static_digest_2026-05-22T07:00:00.000Z  succeeded  2026-05-22T07:00:00.000Z  1         -
```

`list`, `start`, and `cancel` work on the Schedules that code starts with [`startSchedule()`](/docs/schedule/server-api#start-a-schedule-from-code), from a Definition without `cron`. `start` takes `--at` for one run, or `--cron` and `--time-zone` for a repeating one. To pass a payload, give the whole input as JSON with `--input`.

```bash [Terminal]
pnpm vitehub schedule start reminder --at 2026-11-08T09:00:00Z
pnpm vitehub schedule start reminder --input '{"name":"reminder","cron":"0 9 * * 1-5","timeZone":"Europe/Madrid","payload":{"text":"Stand-up"}}'
pnpm vitehub schedule list
pnpm vitehub schedule runs sched_mh1x2y3z_ab12cd34
pnpm vitehub schedule cancel sched_mh1x2y3z_ab12cd34 --yes
```

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`, and `runs` takes `--limit <n>`. Error messages redact credentials. An unknown run id fails with `SCHEDULE_RUN_NOT_FOUND` (`404`), and a store that cannot list the full history fails with `SCHEDULE_HISTORY_INCOMPLETE` (`503`).

## Run Workflows in development

Turn on `hubWorkflow()` and start the dev server. App code, the Console, and the CLI share the same runs.

```bash [Terminal]
pnpm vitehub workflow start welcome '{"name":"Ada"}'
pnpm vitehub workflow get <runId>
pnpm vitehub workflow cancel <runId> --yes
pnpm vitehub workflow resume <token> '{"approved":true}'
pnpm vitehub workflow runs list --status failed
pnpm vitehub workflow runs show <runId>
pnpm vitehub workflow runs clear --yes
```

The argument after the Workflow name or token is the payload, a JSON value, and `--input @file.json` passes the whole input. `cancel` and `runs clear` ask for confirmation unless you pass `--yes`, and every command takes `--json`, `--url <origin>`, and `--timeout`. A run that this runtime did not start needs `--workflow <name>` for `get` and `cancel`. The `workflows` grant allows every command, and `workflows:read` only `get`, `runs list`, and `runs show`.

Resume takes an opaque hook token, not a run id or a signal name. Inline runs stay readable with `get` for five minutes. Inline cancel, Cloudflare cancel and resume, and OpenWorkflow resume return an unsupported-operation error, and an OpenWorkflow start only enqueues work, so a worker must run it.

## Inspect runs in development

`vite dev` keeps every inline run in memory, whoever started it, so you can see what each step did.

| Command | What it does |
| --- | --- |
| `runs list` | Lists runs newest first with status and step count. Filter with `--workflow <name>`, `--status queued\|running\|completed\|failed`, and `--limit <n>`. |
| `runs show <runId>` | Prints each step with its status and times, the error of a failed step, and the run's result. `--json` adds the step outputs. |
| `runs clear --yes` | Removes every recorded run and prints the count, so a test can start from an empty history. It does not cancel active runs. |

The history keeps the newest 200 runs, redacts credentials, and is empty after a restart. Inline runs do not retry, so each step runs once. Runs that Cloudflare Workflows, OpenWorkflow, or native Vercel Workflows start are not recorded, and neither is anything in a build. On a deployment, the `runs` commands fail with `WORKFLOW_RUNS_UNAVAILABLE` (`409`), so read one run with `vitehub workflow get <runId> --workflow <name>`. An unknown id fails with `WORKFLOW_RUN_NOT_FOUND` (`404`).
