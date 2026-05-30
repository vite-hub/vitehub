---
title: Schedule
description: Define recurring cron work for Vite and Nitro apps.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-calendar-clock
frameworks: [vite, nitro]
---

`@vite-hub/schedule` defines recurring cron schedules that can run in Vite and Nitro apps. A Schedule Definition keeps the cron expression and handler together so provider output can discover it.

Use Schedule when an app needs named recurring work such as daily reports, cleanup jobs, or provider-triggered maintenance tasks.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 9 * * *',
  handler: async (context) => {
    console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
  },
})
```

The discovered Schedule name comes from the file path. For example, `server/schedules/daily-report.ts` is discovered as `daily-report`.

## What Schedule Owns

::card-group
  :::card
  ---
  icon: i-lucide-calendar-clock
  title: Schedule definitions
  ---
  Keep recurring cron handlers in `defineSchedule()`.
  :::

  :::card
  ---
  icon: i-lucide-cloud
  title: Provider output
  ---
  Emit Cloudflare and Vercel cron output from discovered definitions.
  :::

  :::card
  ---
  icon: i-lucide-play-circle
  title: Runtime runner
  ---
  Execute Runtime Schedules from one self-hosted process.
  :::
::

## Start Here

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Register Schedule and define a first cron handler.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Basic Runner
  description: Start the self-hosted runner for Runtime Schedules.
  to: ./runner
  ---
  :::
  :::u-page-card
  ---
  title: Boundaries
  description: Review runner limits and current scheduling non-goals.
  to: ./boundaries
  ---
  :::
::
