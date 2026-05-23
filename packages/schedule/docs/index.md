---
title: Schedule
description: Define recurring UTC cron work, manage runtime schedules, and let agents expose schedule tools.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-calendar-clock
frameworks: [vite, nitro]
---

`@vitehub/schedule` gives Vite and Nitro apps one schedule vocabulary for recurring UTC cron work.

A Schedule can be a Static Schedule Definition discovered from source files, a Runtime Schedule record created at runtime, or an Agent Schedule attached inline to an Agent Definition. All of them produce Schedule Runs against discovered handlers or agent invocations.

::code-group
```ts [server/schedules/daily-digest.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(context.id, context.scheduledAt)
})
```

```ts [server/api/schedules.post.ts]
import { schedules } from '@vitehub/schedule'

export default defineEventHandler(async () => {
  return await schedules.create({
    cron: '0 9 * * *',
    target: 'daily-digest',
  })
})
```

```ts [server/agents/digest.ts]
import { defineAgent, schedule } from '@vitehub/agent'

export default defineAgent({
  capabilities: [
    schedule({ schedules: ['0 9 * * *'] }),
  ],
  model,
  adapter: 'ai-sdk',
})
```
::

## What Schedule Solves

Schedule is for recurring cron-based work that should be named, discovered, and run by the active deployment provider.

Use Schedule when:

- A handler should run from a five-field UTC cron expression.
- App code should create or edit recurring Runtime Schedule records.
- An Agent should be invoked on a recurring cron.
- A model should read or manage a scoped set of Runtime Schedules through a Schedule Capability.

Do not use Schedule v1 for one-time jobs, deferred work, backfill, local intervals, or timezone-aware calendars. Use Queue for background job delivery and Workflow for provider-tracked long-running work.

## Discovery Model

::fw{id="vite:dev vite:build"}
Vite discovers Static Schedule Definitions from `src/**/*.schedule.ts`.

The Schedule id comes from the path under `src`, without the `.schedule` suffix. `src/reports/daily.schedule.ts` becomes `reports/daily`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers Static Schedule Definitions from `server/schedules/**`.

The Schedule id comes from the path under `server/schedules`, without the file extension. `server/schedules/reports/daily.ts` becomes `reports/daily`.
::

Use `defineSchedule(..., { id })` when the public id should not follow the file path.

## Runtime Schedules

A Runtime Schedule is a stored recurring cron record:

```ts
await schedules.create({
  cron: '0 9 * * *',
  target: 'daily-digest',
})
```

Runtime Schedules target discovered schedule definitions that opt in with `allowRuntimeSchedules: true`.

## Agent Schedules

Inline Agent Schedules attach recurring cron entries directly to an Agent Definition:

```ts
schedule({
  schedules: [
    '0 9 * * *',
    { cron: '0 17 * * 1-5', id: 'weekday-summary' },
  ],
})
```

Use `schedule({ mode, policy })` when an Agent should receive model-facing tools for scoped Runtime Schedule records.
