---
title: Schedule troubleshooting
description: Fix common Schedule definition, Runtime Schedule, target, and Agent Schedule issues.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite, nitro]
---

## `defineSchedule()` rejects the cron string

**Cause:** Schedule v1 accepts five-field UTC cron expressions only.

**Fix:** Use `minute hour day-of-month month day-of-week`:

```ts
defineSchedule({
  cron: '0 9 * * *',
  handler,
})
```

Do not use `every`, seconds fields, one-time timestamps, or timezone options.

## A Runtime Schedule target is unknown

**Cause:** `schedules.create()` and `schedules.update()` validate `target` against discovered definitions.

**Fix:** Check the discovered file name and import the generated target type:

```ts
import type { ScheduleTargetName } from '#vitehub/schedule/targets'

const target = 'daily-digest' satisfies ScheduleTargetName
```

::fw{id="vite:dev vite:build"}
`src/daily-digest.schedule.ts` becomes `daily-digest`.
::

::fw{id="nitro:dev nitro:build"}
`server/schedules/daily-digest.ts` becomes `daily-digest`.
::

## A Runtime Schedule target is not eligible

**Cause:** The Static Schedule Definition exists, but it did not opt in to Runtime Schedules.

**Fix:** Add `allowRuntimeSchedules: true`:

```ts
export default defineSchedule({
  allowRuntimeSchedules: true,
  cron: '0 9 * * *',
  handler,
})
```

## A renamed file changed the Schedule id

**Cause:** File-name ids are the default.

**Fix:** Keep the discovered file path stable, or update Runtime Schedule targets that reference the old file-derived id:

```ts
// `server/schedules/daily-digest.ts` is discovered as `daily-digest`.
// Moving it to `server/schedules/reports/daily.ts` changes the target to `reports/daily`.
```

## `schedule_edit` cannot create a Runtime Schedule

**Cause:** The Schedule Capability enforces its target allowlist and blocks self-targeting unless explicitly allowed.

**Fix:** Include the target and choose an approval policy:

```ts
schedule({
  mode: 'write',
  policy: 'require-approval',
  targets: ['daily-digest'],
})
```

For self-targeting, opt in deliberately:

```ts
schedule({
  allowSelfTarget: true,
  mode: 'write',
  policy: 'require-approval',
  selfTarget: 'agent/digest',
  targets: ['agent/digest'],
})
```

## A Runtime Schedule disappeared after restart

**Cause:** The configured Runtime Schedule store is not durable.

**Fix:** Configure provider or app storage appropriate for your deployment. In-memory stores are for local experiments and tests.

## A needed feature is missing

Schedule v1 does not include `every` intervals, one-time or deferred schedules, timezone options beyond UTC cron, standalone target definitions, backfill, or configurable retry, overlap, and dedupe policy.

Use Queue for deferred background delivery and Workflow for provider-tracked long-running work.
