---
title: Schedule usage
description: Practical patterns for Static Schedule Definitions, Runtime Schedules, Agent Schedules, and v1 boundaries.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

After the quickstart works, most Schedule code falls into four patterns: define a Static Schedule Definition, opt in Runtime Schedule targets, manage Runtime Schedule records, and attach Agent Schedules or Schedule Capability tools.

## Define Static Schedules

Default-export `defineSchedule(cron, handler, options?)` from a discovered schedule file.

::fw{id="vite:dev vite:build"}
```ts [src/reports/daily.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(context.scheduleId, context.scheduledAt)
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/schedules/reports/daily.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(context.scheduleId, context.scheduledAt)
})
```
::

Cron expressions are five-field UTC cron strings: minute, hour, day of month, month, and day of week.

## Control Schedule Ids

By default, ids come from discovered file names:

::fw{id="vite:dev vite:build"}
- `src/daily-digest.schedule.ts` becomes `daily-digest`
- `src/reports/daily.schedule.ts` becomes `reports/daily`
::

::fw{id="nitro:dev nitro:build"}
- `server/schedules/daily-digest.ts` becomes `daily-digest`
- `server/schedules/reports/daily.ts` becomes `reports/daily`
::

Use `options.id` when the public id should stay stable while a file moves:

```ts
export default defineSchedule('0 9 * * *', handler, {
  id: 'daily-digest',
})
```

## Allow Runtime Schedules

Runtime Schedules can only target discovered definitions that opt in:

```ts
export default defineSchedule('0 9 * * *', handler, {
  allowRuntimeSchedules: true,
})
```

The integration generates typed Runtime Schedule Targets from those opted-in definitions. Application code can import the generated type from the stable ViteHub import path:

```ts
import { schedules } from '@vitehub/schedule'
import type { ScheduleTargetName } from '#vitehub/schedule/targets'

const target = 'daily-digest' satisfies ScheduleTargetName

await schedules.create({
  cron: '0 9 * * *',
  target,
})
```

Runtime Schedule target names are not standalone definitions in v1. They come from Static Schedule Definitions with `allowRuntimeSchedules: true`.

## Manage Runtime Schedules

Use `schedules` from `@vitehub/schedule` to manage recurring Runtime Schedule records:

```ts
import { schedules } from '@vitehub/schedule'

const created = await schedules.create({
  cron: '0 9 * * *',
  enabled: true,
  id: 'daily-digest-9am',
  target: 'daily-digest',
})

const all = await schedules.list()
const same = await schedules.get(created.id)

await schedules.update(created.id, {
  cron: '15 9 * * *',
})

await schedules.disable(created.id)
await schedules.enable(created.id)
await schedules.delete(created.id)
```

Runtime Schedule records are recurring cron records. `create()` does not create a one-time or deferred run.

## Use Agent Schedules

Use inline Agent Schedules when the Agent Definition itself should be invoked on recurring cron entries:

```ts
import { defineAgent, schedule } from '@vitehub/agent'

export default defineAgent({
  capabilities: [
    schedule({
      schedules: [
        '0 9 * * *',
        { cron: '0 17 * * 1-5', id: 'weekday-summary' },
      ],
    }),
  ],
  model,
  adapter: 'ai-sdk',
})
```

String entries get ids from the cron expression, such as `schedule-0-9`. Object entries can set an explicit `id`.

## Expose Schedule Capability Tools

Use `schedule({ mode, policy })` when the model should read or manage scoped Runtime Schedules:

```ts
import { defineAgent, schedule } from '@vitehub/agent'
import type { ScheduleTargetName } from '#vitehub/schedule/targets'

export default defineAgent({
  capabilities: [
    schedule<ScheduleTargetName>({
      mode: 'write',
      policy: 'require-approval',
      targets: ['daily-digest'],
    }),
  ],
  model,
  adapter: 'ai-sdk',
})
```

`mode: 'read'` exposes `schedule_read`. `mode: 'write'` also exposes `schedule_edit`, which can create, update, enable, disable, and delete Runtime Schedules inside the target allowlist.

Self-targeting Runtime Schedules require explicit permission:

```ts
schedule({
  allowSelfTarget: true,
  mode: 'write',
  policy: 'require-approval',
  selfTarget: 'agent/digest',
  targets: ['agent/digest'],
})
```

## V1 Boundaries

Schedule v1 intentionally excludes:

- `every` interval syntax.
- One-time or deferred schedules.
- Timezone options beyond five-field UTC cron.
- Standalone Runtime Schedule target definitions.
- Backfill.
- Configurable retry, overlap, or dedupe policy.

Use provider docs for provider-specific scheduling behavior. General Schedule code should stay provider-neutral.
