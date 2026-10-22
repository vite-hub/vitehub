---
title: Schedule
navigation.title: Overview
description: Run server code at set times from files that deploy as cron on Cloudflare, Vercel, Deno, or a long-lived Node process.
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

  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'node',
        // Keeps Schedule Run history across restarts
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
  Add a file to `server/schedules`. Its name is the schedule name. Cron times use UTC unless the file sets `timeZone`.
  :::

  :::product-feature-item{title="Test without waiting" icon="i-lucide-play-circle" to="/docs/schedule/configure#schedule-definition-options"}
  `manual: true` lets you start a schedule outside its cron time.
  :::

  :::product-feature-item{title="Uses the cron your host has" icon="i-lucide-cloud-cog" to="/docs/schedule/hosts#provider-output"}
  On Cloudflare and Vercel, the build writes the host's own cron settings for you.
  :::

  :::product-feature-item{title="Run on your own server" icon="i-lucide-server" to="/docs/schedule/configure#configure-the-vite-integration"}
  On Node, one long-running process checks for due schedules every minute. Do not use it on serverless hosts.
  :::
::

::agent-only{skill="schedule"}
Use Schedule for recurring wakeups or static cron declarations. A scheduled run should hand off to idempotent application or Agent work.

Read [Get started](https://vitehub.dev/raw/docs/schedule/get-started.md), [Configure](https://vitehub.dev/raw/docs/schedule/configure.md), [Server API](https://vitehub.dev/raw/docs/schedule/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/schedule/hosts.md).

Keep the schedule definition separate from the work it starts. Use a stable key and record the last completed run when the action must not repeat.

Prove one manual run, one scheduled wake, retry or overlap behavior, and the terminal state. Inspect generated cron or provider output.
::
