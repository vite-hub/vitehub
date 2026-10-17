---
title: Schedule
navigation.title: Overview
description: Declare static cron schedules in files and run them on Cloudflare, Vercel, Deno, or a long-lived Node process.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::agent-only{skill="schedule"}
Use Schedule for recurring wakeups or static cron declarations. A scheduled run should hand off to idempotent application or Agent work.

Read [Get started](/docs/schedule/get-started), [Configure](/docs/schedule/configure), [Server API](/docs/schedule/server-api), or [Hosts](/docs/schedule/hosts).

Keep the schedule definition separate from the work it starts. Use a stable key and record the last completed run when the action must not repeat.

Prove one manual run, one scheduled wake, retry or overlap behavior, and the terminal state. Inspect generated cron or provider output.
::

::product-hero{tagline="Run server code at cron times from a file that builds to Cloudflare, Vercel, or Deno cron output." hosts="Cloudflare, Vercel, Deno, Node, Docker"}
  :::code-group
  ```ts [Definition]
  import { defineSchedule } from '@vite-hub/schedule'

  export default defineSchedule({
    cron: '0 8 * * *',
    async handler({ scheduledAt, waitUntil }) {
      await sendDailyReport(scheduledAt)
      waitUntil(recordDelivery())
    },
  })
  ```

  ```ts [Manual run]
  import registry from '#vitehub/schedule/registry'
  import { runSchedule } from '@vite-hub/schedule/runtime'

  export default defineEventHandler(async () => {
    const run = await runSchedule('daily-report', { registry })
    return { id: run.id, status: run.status }
  })
  ```

  ```bash [CLI]
  pnpm vitehub schedule run daily-report
  pnpm vitehub schedule runs daily-report --limit 5 --json
  ```
  :::
::


::product-features
  :::product-feature-item{title="The file is the schedule, in UTC" icon="i-lucide-code-2" to="/docs/schedule/configure#define-a-static-schedule"}
  Deploys with the app; `manual: true` allows runs outside the cron.
  :::

  :::product-feature-item{title="One long-lived process runs every schedule" icon="i-lucide-cpu" to="/docs/schedule/configure#configure-the-vite-integration"}
  On Node, it scans once per minute; never use a serverless host.
  :::

  :::product-feature-item{title="Run and inspect from the CLI" icon="i-lucide-terminal" to="/docs/schedule/hosts"}
  `vitehub schedule run` starts a manual run; `runs` lists recorded runs.
  :::

  :::product-feature-item{title="Cron output stays portable" icon="i-lucide-calendar-clock" to="/docs/schedule/server-api"}
  One schedule definition builds to the host's native trigger format.
  :::
::
