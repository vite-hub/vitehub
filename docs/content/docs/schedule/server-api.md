---
title: Schedule server API
description: Run a schedule on demand, read its run history, and handle errors from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineSchedule` from `@vite-hub/schedule` | Declare a schedule. |
| `runSchedule` from `@vite-hub/schedule/runtime` | Run a Definition with `manual: true` now. |
| `executeSchedule`, `executeStaticSchedule`, `createScheduleRun` from `@vite-hub/schedule/runtime` | Run one occurrence from provider hooks or your own runtime code. |
| `createMemoryScheduleRunStore`, `createKVScheduleRunStore` from `@vite-hub/schedule/runtime` | Store Schedule Runs. |
| `setScheduleRunStore`, `setScheduleRuntimeRegistry` from `@vite-hub/schedule/runtime` | Set your own runtime state. |
| `installProcessScheduleRuntime` from `@vite-hub/schedule/runtime/process` | Run Definitions on their cron in a long-running process. |
| `createScheduleKVStorage` from `@vite-hub/schedule/runtime` | Use a ViteHub KV store as Schedule storage. |
| `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` | Find Definitions in a build plugin. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and generated provider files. |

`@vite-hub/schedule` exports the Definition, Run, and Store types. Framework apps import runtime helpers from `vite-hub/schedule/runtime`. The main entry does not load file discovery or its build dependencies.

## Run a Definition now

`runSchedule(name, { registry })` runs one schedule (a Definition) with `manual: true` now. Each call records a Schedule Run with a `srun_manual_` id, so it never collides with a cron run.

```ts [server/api/reports/run.post.ts]
import { defineEventHandler } from 'h3'
import registry from '#vitehub/schedule/registry'
import { runSchedule } from '@vite-hub/schedule/runtime'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report', { registry })
  return { id: run.id, status: run.status }
})
```

`scheduledAt` runs it as if the cron fired then: `runSchedule('daily-report', { registry, scheduledAt: '2026-01-31T23:59:00Z' })`. It takes a `Date` or an ISO 8601 date-time with `Z` or an offset, and defaults to now. The handler gets it and the run records it.

When the handler fails, `runSchedule()` resolves with the failed run. It rejects with:

- `SCHEDULE_DEFINITION_NOT_FOUND` for an unknown name.
- `SCHEDULE_MANUAL_RUN_DISABLED` when the Definition does not set `manual: true`.
- `SCHEDULE_INVALID_SCHEDULED_AT` when `scheduledAt` is not a valid date-time.

## Run Static Schedules in a custom Node process

The generated Process Runtime calls `installProcessScheduleRuntime()`. Call it yourself on a long-running host without generated Nitro code:

```ts [server/schedule-runtime.ts]
import registry from '#vitehub/schedule/registry'
import { createKVScheduleRunStore } from '@vite-hub/schedule/runtime'
import { scheduleKVStorage } from '@vite-hub/schedule/runtime/kv'
import { installProcessScheduleRuntime } from '@vite-hub/schedule/runtime/process'

const controller = await installProcessScheduleRuntime({
  onError: error => console.error(error),
  registry,
  scheduleRunStore: createKVScheduleRunStore({ kvStore: scheduleKVStorage }),
})

process.once('SIGTERM', () => void controller.close())
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `registry` | `ScheduleDefinitionRegistry` | Required | Definitions that this process runs. |
| `scheduleRunStore` | `ScheduleRunStore` | Required | Stores Schedule Runs. After a restart, catch-up reads the newest cron run of each schedule from it. |
| `onError` | `(error: unknown) => void` | None | Gets handler, store, and `waitUntil` failures. |
| `intervalMs` | `number` | `60_000` | Milliseconds between checks, from 1 to 60000. |
| `concurrency` | `number` | `1` | Maximum runs at the same time. |
| `catchUpMs` | `number` | One hour | How far back to run minutes that no process checked. `0` turns off catch-up. |

Call `controller.close()` on shutdown. It waits for active runs and their `waitUntil` work, then stops the timer.

## Read Schedule Runs

`getScheduleRunStore()` returns the installed store.

- `listRuns({ scheduleId, idPrefix, limit })` lists runs, newest first. `idPrefix` filters run IDs before `limit`, so the Process Runtime reads only the newest `srun_static_` run for catch-up.
- `listAttempts(runId)` lists the attempts of one run.
- In development, `vitehub schedule runs <name>` and `vitehub schedule attempts <runId>` read the same store.

For older custom stores that ignore `idPrefix`, the Process Runtime checks up to 100 more recent records for a cron run. If none is one, it checks the whole `catchUpMs` window instead of guessing a time. Existing static run IDs stop duplicates. Support `idPrefix` to read only one record.
