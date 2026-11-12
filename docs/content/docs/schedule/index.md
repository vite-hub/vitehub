---
title: Schedule
layout: landing
navigation.title: Overview
description: Run server code at set times, as cron on Cloudflare, Vercel, Deno, or a long-running Node process.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::product-hero{tagline="Run server code at set times. One file deploys as cron on your host." hosts="Cloudflare, Vercel, Deno, Node, Docker"}
  :hero-figure{name="schedule"}
::

::code-tree{feature="schedule"}
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

:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    // Keeps Schedule Run history across restarts
    kv: true,
    // Checks for due schedules every minute
    schedule: { runtime: { driver: 'process' } },
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
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
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
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
  Add a file to `server/schedules`. The file name is the schedule name. Cron uses UTC unless you set `timeZone`.
  :::

  :::product-feature-item{title="Test without waiting" icon="i-lucide-play-circle" to="/docs/schedule/configure#schedule-definition-options"}
  `manual: true` lets you start a schedule at any time.
  :::

  :::product-feature-item{title="Uses the cron your host has" icon="i-lucide-cloud-cog" to="/docs/schedule/hosts#provider-output"}
  On Cloudflare and Vercel, the build writes the host's cron settings.
  :::

  :::product-feature-item{title="Start a schedule from code" icon="i-lucide-calendar-clock" to="/docs/schedule/server-api#start-a-schedule-from-code"}
  Leave out `cron`, then call `startSchedule()` with a time or a cron that your users pick. It survives restarts.
  :::

  :::product-feature-item{title="Run on your own server" icon="i-lucide-server" to="/docs/schedule/configure#configure-the-vite-integration"}
  On Node, one long-running process checks for due schedules each minute. Not for serverless hosts.
  :::
::

::agent-only{skill="schedule"}
Use Schedule for recurring wakeups or static cron declarations. When users pick the time, such as reminders, define the Schedule without `cron` and call `startSchedule(name, { at | cron, timeZone, payload })` from `vite-hub/schedule`. A scheduled run should hand off to idempotent application or Agent work.

Keep the schedule definition separate from the work it starts. Use a stable key and record the last completed run when the action must not repeat.

Prove one manual run, one scheduled wake, retry or overlap behavior, and the terminal state. Inspect generated cron or provider output.
::
