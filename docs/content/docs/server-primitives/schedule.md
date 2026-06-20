---
title: Schedule
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 11
icon: i-lucide-calendar-clock
---

Schedule owns cron-based runtime coordination, with first-version public language centered on static cron schedules and recurring Runtime Schedules. Use it for Static Schedule Definitions that produce provider cron output and Runtime Schedules that ViteHub stores durably.

Schedule is not an Agent Capability. A Schedule Target can start an Agent Invocation, but Schedule itself remains server runtime behavior.

## Define a static schedule

Use a Static Schedule Definition when the host needs build-time Provider Output such as cron entries or provider wake configuration.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  async handler(context) {
    await sendDailyReport(context.scheduledAt)
  },
})
```

Cron expressions use the Schedule Time Base, currently UTC. The discovered file name provides the Static Schedule Definition identity.

## Create recurring Runtime Schedules

Runtime Schedules are dynamic cron schedules stored by ViteHub. A Runtime Schedule can target only a Runtime Schedule Target that opted into runtime reuse.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  allowRuntimeSchedules: true,
  cron: '0 8 * * *',
  async handler() {
    await sendDailyReport()
  },
})
```

Use the `schedules` Runtime Helper from server code.

```ts [server/api/schedules.post.ts]
import { schedules } from '@vite-hub/schedule/runtime'

export default defineEventHandler(async () => {
  return schedules.create({
    cron: '30 8 * * 1-5',
    id: 'weekday-report',
    target: 'daily-report',
  })
})
```

Runtime Schedule helpers create, list, get, update, delete, enable, and disable recurring Runtime Schedules. One-time delayed execution is not part of the first-version Scheduling vocabulary; use a recurring cron schedule, Queue delay, or Workflow design when that matches the actual behavior.

## Provider output

Static Schedule Definitions can lower to Provider Output. Runtime Schedules do not automatically create new provider cron entries; a Provider Wake wakes ViteHub scheduling code so it can inspect and execute due Runtime Schedules.

Cloudflare and Vercel differ in their cron and wake mechanics. Keep host-specific wiring in Schedule configuration and generated output.

## Connect it to Agents

The Schedule Capability can let an Agent read or manage allowed Runtime Schedules through Capability policy. Inline Agent Schedules start the owning Agent with Schedule Invocation Input, not a synthetic user message.

Attach a Schedule Capability only when a model should manage schedules. Read [Official capabilities](/docs/capabilities/official-capabilities) for Capability modes and write policy.

## Production boundaries

Schedule Runs, Schedule Run Attempts, retry policy, overlap policy, and dedupe policy belong to Schedule. Naming a policy does not imply every policy is configurable in the first version.

Use UTC unless a later ViteHub API explicitly introduces another Schedule Time Base.

## Next steps

- Use [Queue](/docs/server-primitives/queue) when a provider-supported enqueue delay is enough.
- Use [Workflows](/docs/server-primitives/workflows) for durable orchestration.
- Learn trigger language in [Channels API](/docs/concepts/channels-api).
