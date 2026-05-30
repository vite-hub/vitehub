---
title: Schedule
description: Define future and recurring runtime work without mixing it into agent capabilities.
navigation.order: 10
icon: i-lucide-calendar-clock
---

Schedule is the primitive for future and recurring work. Use it for cron-like jobs, delayed tasks, and runtime-created schedules.

Schedule is not an Agent Capability. A Schedule Target can start an Agent Invocation, but the schedule itself belongs to server runtime behavior.

## Static schedules

Use Static Schedule Definitions when the host needs build-time output such as cron entries.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  async run() {
    await sendDailyReport()
  },
})
```

## Runtime schedules

Use Runtime Helpers when application code needs to create, list, or cancel future work.

```ts [server/api/schedules.post.ts]
import { schedules } from '@vite-hub/schedule/runtime'

export default defineEventHandler(() => {
  return schedules.create({
    target: 'daily-report',
    runAt: new Date(Date.now() + 60_000),
  })
})
```

Runtime schedules do not automatically provision host cron output. Static discovered definitions are the source for host cron configuration.

## Cloudflare cron trigger

Cloudflare cron triggers come from generated worker configuration. Keep that output tied to static schedule definitions.

## Vercel Cron entry

Vercel cron entries come from generated Vercel output. Runtime-created schedules are separate from deployment cron metadata.
