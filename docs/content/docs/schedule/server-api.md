---
title: Schedule server API
description: Create, update, run, and inspect Runtime Schedules from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineSchedule` from `@vite-hub/schedule` | Declare a Static Schedule Definition. |
| `defineScheduleTarget` from `@vite-hub/schedule` | Declare a cronless target for Runtime Schedules. |
| `schedules`, `validateRuntimeScheduleCron` from `@vite-hub/schedule` or `@vite-hub/schedule/runtime` | Manage Runtime Schedules and validate cron strings. |
| `executeSchedule`, `executeStaticSchedule`, `executeRuntimeSchedule`, `createScheduleRun` from `@vite-hub/schedule/runtime` | Execute schedules from provider hooks or custom runtime wiring. |
| `createMemoryRuntimeScheduleStore`, `createKVRuntimeScheduleStore` from `@vite-hub/schedule/runtime` | Configure Runtime Schedule storage. |
| `createMemoryScheduleRunStore`, `createKVScheduleRunStore` from `@vite-hub/schedule/runtime` | Configure Schedule Run storage. |
| `setRuntimeScheduleStore`, `setScheduleRunStore`, `setScheduleRuntimeRegistry` from `@vite-hub/schedule/runtime` | Wire custom runtime state. |
| `installScheduleRuntime` from `@vite-hub/schedule/runtime/driver` | Connect stored Runtime Schedules to a host-owned wake driver. |
| `createProcessScheduleWakeDriver` from `@vite-hub/schedule/runtime/process` | Scan and wake due Runtime Schedules inside a long-running process. |
| `createScheduleKVStorage` from `@vite-hub/schedule/runtime` | Adapt a ViteHub KV store to Schedule storage. |
| `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` | Discover Schedule Definitions in a build integration. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and generated provider output. |

Schedule Definition, Runtime Schedule, Schedule Run, and Schedule Store types are exported from `@vite-hub/schedule`.

This is a breaking import change. Move execution, storage, and runtime state helpers from `@vite-hub/schedule` to `@vite-hub/schedule/runtime`. Move `discoverScheduleDefinitions` to `@vite-hub/schedule/vite`. Framework applications use `vite-hub/schedule/runtime` for runtime helpers. Build integrations import discovery from the owner package. The main entry no longer loads file discovery or its build dependencies; helper behavior is unchanged.

## Create recurring Runtime Schedules

Runtime Schedules are cron schedules stored by ViteHub. A Runtime Schedule can target only a Runtime Schedule Target that opted into runtime reuse. Set an IANA `timeZone` when the cron must follow local civil time and daylight-saving changes. Omit it to use UTC.

Use `defineScheduleTarget()` when the handler runs only through Runtime Schedules and doesn't need its own build-time cron. These targets don't emit static provider output.

```ts [server/schedules/report.ts]
import { defineScheduleTarget } from '@vite-hub/schedule'

export default defineScheduleTarget<{ prompt: string }>({
  async handler({ input }) {
    if (input) await generateReport(input.prompt)
  },
})
```

`defineSchedule()` remains cron-required and can opt into runtime reuse with `allowRuntimeSchedules`:

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
    input: { prompt: 'Summarize yesterday' },
    target: 'report',
    timeZone: 'Europe/Copenhagen',
  })
})
```

## Runtime Schedule input

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cron` | `string` | create only | Five-field cron expression evaluated in `timeZone`, or UTC when `timeZone` is omitted. |
| `target` | `ScheduleTargetName` | create only | A `defineScheduleTarget()` declaration or Static Schedule Definition that set `allowRuntimeSchedules: true`. |
| `id` | `string` | No | Stable Runtime Schedule id. ViteHub generates one when omitted. |
| `enabled` | `boolean` | No | Whether the Runtime Schedule executes. Defaults to `true` on create. |
| `input` | `unknown` | No | Opaque input passed to the target handler as `context.input`. |
| `timeZone` | `string` | No | Named IANA time zone used to evaluate the cron expression. Numeric offsets such as `+01:00` are rejected. Defaults to UTC. |
| `console` | `ScheduleConsoleOptions` | No | `enabled: false` hides the Runtime Schedule in the Console. `dispatch` is stored and shown, but the Console is read-only and does not run Schedules. |

`RuntimeScheduleUpdateInput` accepts `cron`, `target`, `enabled`, `input`, and `timeZone`. Create stores an input snapshot. Providing `input` on update replaces the complete snapshot; omitting it preserves the existing value. Schedule does not merge or interpret input, and the configured store must support the value's serialization requirements. Omitting `timeZone` on update preserves the stored zone; set it explicitly to `UTC` to reset UTC evaluation.

Local cron matching follows conventional daylight-saving behavior: a local time missing during a DST gap is skipped, while both distinct instants in a repeated local time during a DST overlap run.

## Runtime helper methods

| Method | Description |
| --- | --- |
| `schedules.create(input)` | Creates a Runtime Schedule. |
| `schedules.list()` | Lists Runtime Schedules. |
| `schedules.get(id)` | Reads one Runtime Schedule. |
| `schedules.update(id, input)` | Updates a Runtime Schedule. |
| `schedules.delete(id)` | Deletes a Runtime Schedule. |
| `schedules.enable(id)` | Sets `enabled` to `true`. |
| `schedules.disable(id)` | Sets `enabled` to `false`. |
| `schedules.run(id, options?)` | Executes one Runtime Schedule immediately. |
| `schedules.listRuns()` | Lists Schedule Run records. |
| `schedules.getRun(id)` | Reads one Schedule Run record. |
| `schedules.listAttempts(runId)` | Lists attempts for one Schedule Run. |

One-time delayed execution is not part of the first-version Scheduling vocabulary; use a recurring cron schedule, Queue delay, or Workflow design when that matches the actual behavior.

## Definition-owned target inputs

The Vite Integration writes `.vitehub/schedule.d.ts`. Include it in your TypeScript project. The Nuxt Integration includes it automatically. The generated `ScheduleTargetRegistry` maps eligible names to their definitions. `schedules.create()` checks input against the selected target:

```ts
const record = await schedules.create({
  target: "daily-report",
  cron: "0 9 * * *",
  input: { prompt: "Summarize yesterday" },
})
await schedules.update(record.id, {
  target: "daily-report",
  input: { prompt: "Summarize this week" },
})
await schedules.update(record.id, { enabled: false })
```

When an update changes `input`, also supply `target`. When an update changes `target`, supply the new input or `input: undefined` to clear it. An ID alone does not identify a definition type. Stored records can outlive a deployment, so `get()`, `list()`, and `update()` return unknown input. Handler input remains optional; targets must handle records with no input.

Use `schedules.dynamic.create()` and `schedules.dynamic.update()` when names or stored input come from external data. The dynamic methods validate target eligibility and Schedule fields. They do not validate a target's business input. Validate that data in the application and again in a target that reads durable records.

This is a breaking change: include the generated declarations for typed application calls, and move operational calls with unknown names to `schedules.dynamic`. There is no permissive string overload on typed creation.
