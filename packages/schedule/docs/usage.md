---
title: Schedule usage
description: Practical patterns for schedule definitions, Runtime Schedules, runtime-eligible targets, and run inspection.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-calendar-plus
frameworks: [vite, nitro]
---

After Schedule discovery is configured, most application code falls into three patterns: define a schedule target, create or update Runtime Schedules, and inspect run records.

## Define a runtime-eligible target

Runtime Schedules can only target definitions that opt in with `allowRuntimeSchedules: true`.

::fw{id="vite:dev vite:build"}
```ts [src/reports/daily.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log('daily report', context.scheduleId, context.scheduledAt)
}, {
  allowRuntimeSchedules: true,
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/schedules/reports/daily.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log('daily report', context.scheduleId, context.scheduledAt)
}, {
  allowRuntimeSchedules: true,
})
```
::

The cron string on the definition still describes the static schedule. Runtime Schedules store their own cron expression and use the definition as the target handler.

## Create a Runtime Schedule

Use `schedules.create()` from server code after validating the caller is allowed to create recurring work.

```ts
import { schedules } from '@vitehub/schedule'

const runtimeSchedule = await schedules.create({
  cron: '0 9 * * *',
  id: 'daily-report',
  target: 'reports/daily',
})
```

Runtime Schedule cron expressions are five-field UTC cron expressions. The helper rejects unknown targets and targets that did not set `allowRuntimeSchedules: true`.

## Update and disable schedules

```ts
await schedules.update('daily-report', {
  cron: '30 9 * * 1-5',
})

await schedules.disable('daily-report')
await schedules.enable('daily-report')
await schedules.delete('daily-report')
```

Disabling a Runtime Schedule prevents automatic runner dispatch and direct `schedules.run(id)` execution.

## Run one schedule manually

Use `schedules.run()` when an explicit action should execute a Runtime Schedule now or for a known scheduled minute.

```ts
const run = await schedules.run('daily-report', {
  scheduledAt: new Date('2026-05-24T09:00:00.000Z'),
})
```

Each run is keyed by Runtime Schedule id and scheduled minute. Re-running the same id for the same `scheduledAt` returns the existing run instead of creating another attempt.

## Start automatic execution

Runtime Schedules do not execute automatically until a process starts the [Basic Self-Hosted Schedule Runner](./runner).

```ts
import { startScheduleRunner } from '@vitehub/schedule'

const runner = startScheduleRunner()

process.once('SIGTERM', () => runner.stop())
```

Read [Boundaries](./boundaries) before running more than one process against the same schedule store.

## Inspect runs

```ts
const runs = await schedules.listRuns()
const run = await schedules.getRun('srun_daily-report_2026-05-24T09:00:00.000Z')
const attempts = await schedules.listAttempts(run!.id)
```

Run status values are `pending`, `running`, `succeeded`, and `failed`. Attempt status values are `running`, `succeeded`, and `failed`.
