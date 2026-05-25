---
title: Schedule
description: Define recurring cron work for Vite and Nitro apps.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-calendar-clock
frameworks: [vite, nitro]
---

`@vitehub/schedule` defines recurring cron schedules that can run in Vite and Nitro apps. A Schedule Definition keeps the cron expression and handler together so provider output can discover it.

Use Schedule when an app needs named recurring work such as daily reports, cleanup jobs, or provider-triggered maintenance tasks.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
})
```

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
::
