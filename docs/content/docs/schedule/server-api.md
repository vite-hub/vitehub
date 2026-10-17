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
| `runScheduleTask`, `getScheduleTaskName` from `@vite-hub/schedule/runtime/static` | Run a Static Schedule Definition from the Nitro task that `vite build` registers. |
| `createScheduleKVStorage` from `@vite-hub/schedule/runtime` | Adapt a ViteHub KV store to Schedule storage. |
| `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` | Discover Schedule Definitions in a build integration. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and the Nitro scheduled tasks. |

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

## Read Schedule Runs

`getScheduleRunStore()` returns the installed store. `listRuns({ scheduleId, limit })` lists runs newest first, and `listAttempts(runId)` lists the attempts of one run. `vitehub schedule runs <name>` and `vitehub schedule attempts <runId>` read the same store in development.
