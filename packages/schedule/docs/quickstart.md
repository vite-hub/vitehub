---
title: Schedule quickstart
description: Register Schedule and define a first cron handler.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one discovered Schedule Definition.

::steps

### Install Schedule

```bash
pnpm add @vitehub/schedule
```

### Register the integration

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubSchedule } from '@vitehub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSchedule(),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/schedule/nitro'],
})
```
::

### Define a schedule

::fw{id="vite:dev vite:build"}
```ts [src/daily-report.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
})
```
::

::

## Verify

The schedule is available through the generated registry. Provider builds can lower discovered static schedules into Cloudflare or Vercel cron output.
