---
title: Schedule server API
description: Run Static Schedule Definitions on demand and read Schedule Runs from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineSchedule` from `@vite-hub/schedule` | Declare a Static Schedule Definition. |
| `runSchedule` from `@vite-hub/schedule/runtime` | Run a Definition that sets `manual: true` now. |
| `executeSchedule`, `executeStaticSchedule`, `createScheduleRun` from `@vite-hub/schedule/runtime` | Execute one occurrence from provider hooks or custom runtime wiring. |
| `createMemoryScheduleRunStore`, `createKVScheduleRunStore` from `@vite-hub/schedule/runtime` | Configure Schedule Run storage. |
| `setScheduleRunStore`, `setScheduleRuntimeRegistry` from `@vite-hub/schedule/runtime` | Wire custom runtime state. |
| `installProcessScheduleRuntime` from `@vite-hub/schedule/runtime/process` | Run Static Schedule Definitions on their cron inside a long-running process. |
| `createScheduleKVStorage` from `@vite-hub/schedule/runtime` | Adapt a ViteHub KV store to Schedule storage. |
| `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` | Discover Schedule Definitions in a build integration. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and generated provider output. |

Schedule Definition, Schedule Run, and Schedule Store types are exported from `@vite-hub/schedule`.

Execution, storage, and runtime state helpers live in `@vite-hub/schedule/runtime`. `discoverScheduleDefinitions` lives in `@vite-hub/schedule/vite`. Framework applications use `vite-hub/schedule/runtime` for runtime helpers. The main entry does not load file discovery or its build dependencies.

## Run a Definition now

`runSchedule(name, { registry })` runs one Static Schedule Definition immediately. The Definition must set `manual: true`. Each call creates a new Schedule Run with a `srun_manual_` id, so a manual run never collides with a cron occurrence.

```ts [server/api/reports/run.post.ts]
import registry from '#vitehub/schedule/registry'
import { runSchedule } from '@vite-hub/schedule/runtime'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report', { registry })
  return { id: run.id, status: run.status }
})
```

When the handler fails, `runSchedule()` resolves with the failed run. It rejects with `SCHEDULE_DEFINITION_NOT_FOUND` for an unknown name and with `SCHEDULE_MANUAL_RUN_DISABLED` when the Definition does not set `manual: true`.

## Run Static Schedules in a custom Node process

The generated Process Runtime calls `installProcessScheduleRuntime()`. Call it yourself when a custom long-running host does not use the generated Nitro wiring:

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
| `registry` | `ScheduleDefinitionRegistry` | Required | Static Schedule Definitions that this process runs. |
| `scheduleRunStore` | `ScheduleRunStore` | Required | Stores Schedule Runs. Catch-up after a restart reads the newest run of each Schedule from it. |
| `onError` | `(error: unknown) => void` | None | Receives handler, store, and `waitUntil` failures. |
| `intervalMs` | `number` | `60_000` | Milliseconds between two checks, from 1 to 60000. |
| `concurrency` | `number` | `1` | Maximum number of runs at the same time. |
| `catchUpMs` | `number` | One hour | How far back the runtime runs minutes that no process checked. `0` disables catch-up. |

Call `controller.close()` during shutdown. It waits for active runs and their `waitUntil` work, then stops the timer.

## Read Schedule Runs

`getScheduleRunStore()` returns the installed store. `listRuns({ scheduleId, limit })` lists runs newest first, and `listAttempts(runId)` lists the attempts of one run. `vitehub schedule runs <name>` and `vitehub schedule attempts <runId>` read the same store in development.
