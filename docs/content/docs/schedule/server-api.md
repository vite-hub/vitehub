---
title: Schedule server API
description: Start Schedules from code, run Static Schedule Definitions on demand, and read Schedule Runs from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineSchedule` from `vite-hub/schedule` | Declare a Static Schedule Definition, or a Definition without `cron` that code starts. |
| `startSchedule`, `getSchedule`, `listSchedules`, `cancelSchedule` from `vite-hub/schedule` | Start a Definition without `cron` once or on a cron, and read or cancel what you started. |
| `runSchedule` from `vite-hub/schedule` | Run a Definition that sets `manual: true` now. |
| `executeSchedule`, `executeStaticSchedule`, `createScheduleRun` from `vite-hub/schedule/runtime` | Execute one occurrence from provider hooks or custom runtime wiring. |
| `createMemoryScheduleRunStore`, `createKVScheduleRunStore` from `vite-hub/schedule/runtime` | Configure Schedule Run storage. |
| `setScheduleRunStore` from `vite-hub/schedule/runtime` | Wire custom runtime state. |
| `installProcessScheduleRuntime` from `vite-hub/schedule/runtime/process` | Run Static Schedule Definitions on their cron inside a long-running process. |
| `createScheduleKVStorage` from `vite-hub/schedule/runtime` | Adapt a ViteHub KV store to Schedule storage. |
| `installStartedSchedules`, `runStartedSchedules`, `createKVStartedScheduleStore`, `createMemoryStartedScheduleStore` from `vite-hub/schedule/runtime` | Wire the store and the tick of started Schedules yourself. The generated Nitro plugin does it for you. |
| `discoverScheduleDefinitions`, `discoverStartableScheduleDefinitions` from `@vite-hub/schedule/vite` | Discover Schedule Definitions in a build integration. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and generated provider output. |

`vite-hub/schedule` exports the Definition, Run, and Store types. Framework apps import runtime helpers from `vite-hub/schedule/runtime`. The main entry does not load file discovery or its build dependencies.

## Start a Schedule from code

A Static Schedule runs on the cron in its file. When the time comes from your users, such as a reminder that someone asks for in a chat, leave out `cron` and start the Schedule from code.

```ts [server/schedules/reminder.ts] fragment
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({
  async handler({ payload, scheduledAt }) {
    await sendReminder(payload, scheduledAt)
  },
})
```

The route uses Valibot to validate the request body (`pnpm add valibot`):

```ts [server/api/reminders.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import { object, parse, string } from 'valibot'
import { startSchedule } from 'vite-hub/schedule'

export default defineEventHandler(async (event) => {
  const { at, text } = await readValidatedBody(event, body => parse(object({ at: string(), text: string() }), body))
  const [error, schedule] = await startSchedule('reminder', { at, payload: { text } })
  if (error) throw error
  return { id: schedule.id }
})
```

`startSchedule(name, options)` stores the Schedule and returns it. The handler of `name` runs:

- once, at the first minute at or after `at`, when you pass `at`: a `Date` or an ISO 8601 date-time with `Z` or an offset;
- on each occurrence of `cron` in `timeZone` (UTC by default), when you pass `cron`, until you cancel it.

Pass `at` or `cron`, not both. `payload` is a JSON value that the handler gets as `context.payload`. The run has `scheduleId` set to the id of the started Schedule and `target` set to `name`.

| Function | Returns |
| --- | --- |
| `startSchedule(name, { at, payload })` or `startSchedule(name, { cron, timeZone, payload })` | `Result<StartedSchedule>` |
| `getSchedule(id)` | `Result<StartedSchedule>` |
| `listSchedules({ name })` | `Result<StartedSchedule[]>`, oldest first. `name` is optional. |
| `cancelSchedule(id)` | `Result<StartedSchedule>`, the Schedule that it removed. A run that already started finishes. |

Each function returns `[error, data]` and does not throw. A one-time Schedule leaves the store after its run, also when the handler fails. Its run stays in the run history: `vitehub schedule runs <id>` lists it.

### How started Schedules run

When a Definition has no `cron`, the build adds one more Schedule, `vitehub/started-schedules`, with the cron `* * * * *`. The host wakes it like any Static Schedule: a Cron Trigger on Cloudflare, the Process Runtime on Node. Each wake reads the started Schedules from KV and runs the due ones. So started Schedules need `kv`, and on Node they need `schedule: { runtime: { driver: 'process' } }`.

- The store is KV, one key for each Schedule under `vitehub:schedule/started-schedules/`, or under the `runtime.prefix` that you set. It survives restarts and deploys.
- With the Process Runtime, the first wake after a restart runs the cron minutes that no process checked, within `catchUpMs` (one hour by default). A one-time Schedule whose `at` passed while the process was down runs at the first wake.
- On Cloudflare, each wake checks its own minute only, because the run history is in memory there. A Cron Trigger that does not fire skips that minute for cron Schedules.
- Each occurrence has the run id `srun_started_<id>_<time>`. The same Process Runtime does not run an occurrence twice. On Cloudflare, KV is eventually consistent, so a one-time Schedule can run twice when two wakes see it. Use `context.runId` as an idempotency key for side effects that must happen once.
- The `vitehub/started-schedules` wake records no run of its own. It sets `manual: true`, so `vitehub schedule run vitehub/started-schedules` and the Console run action check for due Schedules now.
- On Cloudflare, each wake lists the KV keys of started Schedules once a minute. That is about 43,200 list operations a month, more than the 1,000 a day of the Workers Free plan.

Only the Process Runtime on Node and Nitro builds on Cloudflare are tested. Vercel Hobby runs cron jobs at most once a day, so the minute wake fails its deploy.

### Errors

#### `SCHEDULE_NOT_STARTABLE`

No Schedule Definition without `cron` has that name. A Definition with its own `cron` runs only on that cron. Add `server/schedules/<name>.ts` with `defineSchedule({ handler })` and no `cron`.

#### `SCHEDULE_INVALID_OPTIONS`

The options are not valid: both or neither of `at` and `cron`, a cron that is not five fields, a `timeZone` that is not an IANA name or that comes with `at`, an `at` without a time zone, or a `payload` that is not JSON.

#### `SCHEDULE_NOT_FOUND`

No started Schedule has that id. It ran its last time, someone cancelled it, or it never existed.

#### `SCHEDULE_STORE_MISSING`

The server has no store for started Schedules. The generated Nitro plugin installs it when a Definition has no `cron`. Check that the app builds with Nitro and enables `kv`.

#### `SCHEDULE_STORE_FAILED`

KV failed. `error.cause` has the KV error.

## Run a Definition now

`runSchedule(name)` runs one Static Schedule Definition immediately. It reads the Static Schedule Definitions that ViteHub discovered. The Definition must set `manual: true`. Each call creates a new Schedule Run with a `srun_manual_` id, so a manual run never collides with a cron occurrence.

```ts [server/api/reports/run.post.ts]
import { defineEventHandler } from 'h3'
import { runSchedule } from 'vite-hub/schedule'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report')
  return { id: run.id, status: run.status }
})
```

Pass `scheduledAt` to run the Definition as if its cron fired at that time: `runSchedule('daily-report', { scheduledAt: '2026-01-31T23:59:00Z' })`. It takes a `Date` or an ISO 8601 date-time with `Z` or an offset. The handler gets it as `scheduledAt`, and the run records it. It defaults to now.

When the handler fails, `runSchedule()` resolves with the failed run. It rejects with:

- `SCHEDULE_DEFINITION_NOT_FOUND` for an unknown name.
- `SCHEDULE_MANUAL_RUN_DISABLED` when the Definition does not set `manual: true`.
- `SCHEDULE_INVALID_SCHEDULED_AT` when `scheduledAt` is not a valid date-time.

## Run Static Schedules in a custom Node process

The generated Process Runtime calls `installProcessScheduleRuntime()`. Call it yourself on a long-running host without generated Nitro code:

```ts [server/schedule-runtime.ts]
import registry from '#vitehub/schedule/registry'
import { createSqlLeaseStore } from '@vite-hub/runtime'
import { createKVScheduleRunStore } from 'vite-hub/schedule/runtime'
import { scheduleKVStorage } from 'vite-hub/schedule/runtime/kv'
import { installProcessScheduleRuntime } from 'vite-hub/schedule/runtime/process'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)
const controller = await installProcessScheduleRuntime({
  leases: createSqlLeaseStore({ dialect: 'postgresql', query: (text, params) => sql.unsafe(text, params) }),
  onError: error => console.error(error),
  registry,
  scheduleRunStore: createKVScheduleRunStore({ kvStore: scheduleKVStorage }),
})

process.once('SIGTERM', () => void controller.close())
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `registry` | `ScheduleDefinitionRegistry` | Required | Static Schedule Definitions that this process runs. |
| `scheduleRunStore` | `ScheduleRunStore` | Required | Stores Schedule Runs. Catch-up after a restart reads the newest cron-triggered run of each Schedule from it. |
| `onError` | `(error: unknown) => void` | None | Receives handler, store, and `waitUntil` failures. |
| `intervalMs` | `number` | `60_000` | Milliseconds between two checks, from 1 to 60000. |
| `concurrency` | `number` | `1` | Maximum number of runs at the same time. |
| `catchUpMs` | `number` | One hour | How far back the runtime runs minutes that no process checked. `0` disables catch-up. |
| `leases` | `LeaseStore` | `createMemoryLeaseStore()` | Where processes claim each occurrence, so one process runs it. Give every process the same shared store. The memory store works for one process only. |
| `prefix` | `string` | `vitehub:schedule` | Namespace for occurrence leases. Use the same prefix as the app's Schedule stores, and a different prefix for each app that shares a Database. |
| `leaseTtlMs` | `number` | `60_000` | Milliseconds that a process holds an occurrence after it stops renewing it, for example after a crash. Then another process runs it, unless a process finished it. |

Call `controller.close()` on shutdown. It waits for active runs and their `waitUntil` work, then stops the timer.

## Read Schedule Runs

`getScheduleRunStore()` returns the installed store.

- `listRuns({ scheduleId, idPrefix, limit })` lists runs, newest first. `idPrefix` filters run IDs before `limit`, so the Process Runtime reads only the newest `srun_static_` run for catch-up.
- `listAttempts(runId)` lists the attempts of one run.
- In development, `vitehub schedule runs <name>` and `vitehub schedule attempts <runId>` read the same store.

For older custom stores that ignore `idPrefix`, the Process Runtime checks up to 100 more recent records for a cron run. If none is one, it checks the whole `catchUpMs` window instead of guessing a time. Existing static run IDs stop duplicates. Support `idPrefix` to read only one record.
