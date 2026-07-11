---
title: Schedule
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 11
icon: i-lucide-calendar-clock
---

Schedule owns cron-based runtime coordination, with first-version public language centered on static cron schedules and recurring Runtime Schedules. Use it for Static Schedule Definitions that produce provider cron output and Runtime Schedules that ViteHub stores durably.

Schedule is not an Agent Capability. A Schedule Target can start an Agent Invocation, but Schedule itself remains server runtime behavior.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/schedule
```

### Configure

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSchedule()],
})
```

### Start using it

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  async handler(context) {
    await sendDailyReport(context.scheduledAt)
  },
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSchedule` from `@vite-hub/schedule` | Declare a Static Schedule Definition. |
| `schedules`, `validateRuntimeScheduleCron` from `@vite-hub/schedule` or `@vite-hub/schedule/runtime` | Manage Runtime Schedules and validate cron strings. |
| `executeSchedule`, `executeStaticSchedule`, `executeRuntimeSchedule`, `createScheduleRun` from `@vite-hub/schedule` | Execute schedules from provider hooks or custom runtime wiring. |
| `startScheduleRunner` from `@vite-hub/schedule` | Run due Runtime Schedules on long-running hosts. |
| `createMemoryRuntimeScheduleStore`, `createKVRuntimeScheduleStore` from `@vite-hub/schedule` | Configure Runtime Schedule storage. |
| `createMemoryScheduleRunStore`, `createKVScheduleRunStore` from `@vite-hub/schedule` | Configure Schedule Run storage. |
| `setRuntimeScheduleStore`, `setScheduleRunStore`, `setScheduleRuntimeRegistry` from `@vite-hub/schedule` | Wire custom runtime state. |
| `installScheduleRuntime` from `@vite-hub/schedule/runtime/driver` | Connect stored Runtime Schedules to a host-owned wake driver. |
| `hubSchedule`, `createScheduleNitroConfig` from `@vite-hub/schedule/vite` | Register discovery and generated provider output. |

Schedule Definition, Runtime Schedule, Schedule Run, Schedule Store, and runner types are exported from `@vite-hub/schedule`.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSchedule()],
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `providerOutput` | `ScheduleVitePluginOptions['providerOutput']` | `auto` | Controls generated provider cron output. Values: `auto`, `standalone`, `nitro`, `false`. |
| `projectRoot` | `string` | ViteHub project root | Resolves discovered schedule files and generated registry output from a custom project root. |

Use `createScheduleNitroConfig()` when a Nitro integration owns config merging and needs Schedule to return Nitro-ready provider output.

## Provider output

| Mode | Output | Nuance |
| --- | --- | --- |
| `auto` | Selects the appropriate generated output for the active build context. | Default mode for Vite projects. |
| `standalone` | Writes standalone provider output outside Nitro. | Use when ViteHub owns provider output directly. |
| `nitro` | Writes Nitro Cloudflare module and plugin output. | Use when Nitro owns Cloudflare cron wiring. |
| `false` | Disables generated provider output. | Runtime helpers still work when you wire execution yourself. |

| Host | Static Schedule output | Runtime Schedule nuance |
| --- | --- | --- |
| Cloudflare | Cron trigger output and Cloudflare schedule runtime entry wiring. | Runtime Schedules still need Provider Wake output or a long-running runner. |
| Vercel | Vercel cron-compatible output for static schedules. | Runtime Schedules still need Provider Wake output or a long-running runner. |
| Deno | `Deno.cron` output loaded by generated Deno Agent server output. | Runtime Schedules still need Provider Wake output or a long-running runner. |

::warning
Provider Wake output requires a static five-field UTC cron string compatible with generated provider output. Runtime Schedules still need an existing Provider Wake or a long-running host to execute due schedules.
::

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

## Schedule Definition options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `cron` | `string` | Yes | Five-field UTC cron expression for the Static Schedule Definition. |
| `handler` | `ScheduleHandler` | Yes | Function called with Schedule Run Context. |
| `allowRuntimeSchedules` | `boolean` | No | Allows Runtime Schedules to target this definition. |

`ScheduleRunContext` includes `id`, `scheduledAt`, optional `attemptId`, optional `runId`, optional Runtime Schedule id, and optional Runtime Schedule target.

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

## Runtime Schedule input

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cron` | `string` | create only | Five-field UTC cron expression. |
| `target` | `ScheduleTargetName` | create only | Static Schedule Definition that set `allowRuntimeSchedules: true`. |
| `id` | `string` | No | Stable Runtime Schedule id. ViteHub generates one when omitted. |
| `enabled` | `boolean` | No | Whether the Runtime Schedule should execute. Defaults to `true` on create. |

`RuntimeScheduleUpdateInput` accepts `cron`, `target`, and `enabled`.

## Runtime Helper methods

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

## Connect a Runtime Schedule Wake Driver

Host integrations use the runtime driver boundary when the host can create and remove native wake registrations dynamically.

```ts [server/runtime/schedule.ts]
import { installScheduleRuntime } from '@vite-hub/schedule/runtime/driver'

const controller = await installScheduleRuntime({
  createDriver: context => hostScheduler.driver(context),
  registry: scheduleRegistry,
  runtimeScheduleStore,
  scheduleRunStore,
})
```

`createDriver(context)` returns a driver with `reconcile(schedules)`. Every reconciliation receives the complete stored snapshot, including disabled records. Installation awaits the initial reconciliation before it succeeds.

Runtime Schedule creates, updates, and deletes are serialized through the installed runtime. Each mutation persists to the canonical store before reconciliation. If reconciliation fails, ViteHub restores the previous stored record and rejects the mutation. Manual `schedules.run()` calls execute immediately and do not reconcile the driver.

When the host fires a native wake, call `context.wake({ scheduleId, scheduledAt })` with the exact stored Runtime Schedule id and occurrence time. Call `controller.close()` during host shutdown to release process resources; closing does not delete definitions, schedules, or run history.

`startScheduleRunner()` remains the polling compatibility path for long-running hosts. Static provider output remains build-time configuration and does not use this runtime driver boundary.

## Storage

| Store | Configure with | Nuance |
| --- | --- | --- |
| Memory Runtime Schedule Store | `createMemoryRuntimeScheduleStore()` | Default in-process behavior; useful for tests and local runtime only. |
| KV Runtime Schedule Store | `createKVRuntimeScheduleStore(options?)` | Persists Runtime Schedule records through a KV-compatible storage object. |
| Memory Schedule Run Store | `createMemoryScheduleRunStore()` | Default in-process run history; useful for tests and local runtime only. |
| KV Schedule Run Store | `createKVScheduleRunStore(options?)` | Persists Schedule Runs and attempts through KV-compatible storage. |
| Custom Store | `setRuntimeScheduleStore(store)`, `setScheduleRunStore(store)` | Implement `RuntimeScheduleStore` or `ScheduleRunStore` directly. |

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
