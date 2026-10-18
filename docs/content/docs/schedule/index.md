---
title: Schedule
navigation.title: Overview
description: Run server code at set times, and create new schedules from your routes while the app runs.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::product-hero{tagline="Run server code at set times, from one file that deploys as cron on your host." hosts="Cloudflare, Vercel, Deno, Node, Docker"}
  :::product-files
  ```ts [server/schedules/daily-report.ts]
  import { defineSchedule } from 'vite-hub/schedule'

  // Runs every day at 08:00 UTC.
  export default defineSchedule({
    cron: '0 8 * * *',
    // You can also start it by hand to test it
    manual: true,
    handler({ scheduledAt }) {
      console.log('Report for', scheduledAt.toISOString())
    },
  })
  ```

  ```ts [server/schedules/reminder.ts]
  import { defineScheduleTarget } from 'vite-hub/schedule'

  // No cron here. Your routes choose the times.
  export default defineScheduleTarget<{ text: string }>({
    handler({ input }) {
      if (input) console.log(input.text)
    },
  })
  ```

  ```ts [server/api/reminders.post.ts]
  import { defineEventHandler } from 'h3'
  import { schedules } from 'vite-hub/schedule'

  // Weekdays at 08:30, Copenhagen time
  export default defineEventHandler(() => {
    return schedules.create({
      target: 'reminder',
      cron: '30 8 * * 1-5',
      timeZone: 'Europe/Copenhagen',
      input: { text: 'Stand-up in 30 minutes' },
    })
  })
  ```

  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'node',
        // Keeps the schedules your routes create
        kv: true,
        // Checks for due schedules every minute
        schedule: { runtime: { driver: 'process' } },
      }),
    ],
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file per schedule" icon="i-lucide-file-code-2" to="/docs/schedule/configure#define-a-static-schedule"}
  Add a file to `server/schedules`. Its name is the schedule name. Cron times use UTC.
  :::

  :::product-feature-item{title="Test without waiting" icon="i-lucide-play-circle" to="/docs/schedule/configure#schedule-definition-options"}
  `manual: true` lets you start a schedule outside its cron time.
  :::

  :::product-feature-item{title="Create schedules from a route" icon="i-lucide-calendar-plus" to="/docs/schedule/server-api#create-recurring-runtime-schedules"}
  `schedules.create()` saves a new cron while the app runs. It can only start handlers that allow it.
  :::

  :::product-feature-item{title="Use local time" icon="i-lucide-globe" to="/docs/schedule/server-api#runtime-schedule-input"}
  Schedules you create can use a time zone such as `Europe/Copenhagen`. Daylight saving changes are handled.
  :::

  :::product-feature-item{title="Uses the cron your host has" icon="i-lucide-cloud-cog" to="/docs/schedule/hosts#provider-output"}
  On Cloudflare and Vercel, the build writes the host's own cron settings for you.
  :::

  :::product-feature-item{title="Run on your own server" icon="i-lucide-server" to="/docs/schedule/configure#configure-the-vite-integration"}
  On Node, one long-running process checks for due schedules every minute. Do not use it on serverless hosts.
  :::
::
