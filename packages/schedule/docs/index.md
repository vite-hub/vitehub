---
title: Schedule
description: Define cron schedules and manage Runtime Schedules with explicit self-hosted runner boundaries.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-calendar-clock
frameworks: [vite, nitro]
---

`@vitehub/schedule` gives Vite and Nitro apps one way to define named cron work, create user-managed Runtime Schedules, and execute them from a process that you own.

Use Schedule when recurring work should call a discovered handler. Static schedules live in code. Runtime Schedules live in a store and target definitions that explicitly opt in with `allowRuntimeSchedules: true`.

::code-group
```ts [server/schedules/reports.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log('Running report for', context.scheduledAt.toISOString())
}, {
  allowRuntimeSchedules: true,
})
```

```ts [server/api/schedules.post.ts]
import { schedules } from '@vitehub/schedule'

export default defineEventHandler(async () => {
  return await schedules.create({
    cron: '0 9 * * *',
    id: 'daily-report',
    target: 'reports',
  })
})
```
::

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers schedule definitions from `src/**/*.schedule.ts`.

The schedule name comes from the path under `src`, without the `.schedule` suffix. `src/reports/daily.schedule.ts` becomes `reports/daily`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers schedule definitions from `server/schedules/**`.

The schedule name comes from the path under `server/schedules`, without the file extension. `server/schedules/reports/daily.ts` becomes `reports/daily`.
::

## Runtime Schedules

Runtime Schedules are persisted records with an id, cron expression, enabled flag, and target. They are useful when users or application state decide which recurring work should exist.

Only targets that set `allowRuntimeSchedules: true` can be used by Runtime Schedules. This keeps runtime-created records from calling every static schedule handler by accident.

Start with [Usage](./usage), then add the [Basic Self-Hosted Schedule Runner](./runner) when Runtime Schedules need automatic execution.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Usage
  description: Define schedules, create Runtime Schedules, and inspect runs.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Basic Runner
  description: Start the self-hosted runner from a Node, Nitro, or server entry point.
  to: ./runner
  ---
  :::
  :::u-page-card
  ---
  title: Boundaries
  description: Review current runner limits and out-of-scope production provider behavior.
  to: ./boundaries
  ---
  :::
::
