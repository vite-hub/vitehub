---
title: Schedule runtime API
description: Reference for Schedule exports, definition options, Runtime Schedule records, and Agent Schedule helpers.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names, signatures, and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Most application code imports from `@vitehub/schedule`:

```ts
import {
  defineSchedule,
  schedules,
} from '@vitehub/schedule'
```

::fw{id="vite:dev vite:build"}
Vite config imports the plugin from `@vitehub/schedule/vite`:

```ts
import { hubSchedule } from '@vitehub/schedule/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/schedule/nitro'],
})
```

The Nitro module auto-imports `defineSchedule` for discovered schedule definitions.
::

Generated Runtime Schedule Targets use the stable ViteHub import path:

```ts
import { scheduleTargetNames } from '#vitehub/schedule/targets'
import type { ScheduleTargetName } from '#vitehub/schedule/targets'
```

## Definition API

### `defineSchedule(cron, handler, options?)`

Default-export `defineSchedule()` from every discovered Static Schedule Definition.

```ts
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(context.id, context.scheduledAt)
}, {
  allowRuntimeSchedules: true,
  id: 'daily-digest',
})
```

### `ScheduleRunContext`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Schedule Run id. |
| `attemptId` | `string \| undefined` | Current attempt id when available. |
| `runId` | `string \| undefined` | Provider or runtime run id when available. |
| `scheduleId` | `string \| undefined` | Static or Runtime Schedule id that produced the run. |
| `scheduledAt` | `Date` | Scheduled UTC time for this run. |
| `target` | `ScheduleTargetName \| undefined` | Runtime Schedule target name when the run came from a Runtime Schedule. |

### `ScheduleDefinitionOptions`

| Option | Type | Description |
| --- | --- | --- |
| `allowRuntimeSchedules` | `boolean` | Adds this discovered definition to the generated Runtime Schedule target set. |
| `id` | `string` | Overrides the discovered file-name id. |
| `target` | `ScheduleTargetName` | Stores an explicit target name with the definition. |

## Runtime Schedule Client

### `schedules.create(input)`

Create a recurring Runtime Schedule record.

```ts
const record = await schedules.create({
  cron: '0 9 * * *',
  enabled: true,
  id: 'daily-digest-9am',
  target: 'daily-digest',
})
```

`target` must name a discovered definition with `allowRuntimeSchedules: true`.

### `schedules.list()`

Return all Runtime Schedule records visible to the configured runtime store:

```ts
const records = await schedules.list()
```

### `schedules.get(id)`

Return one Runtime Schedule record or `undefined`:

```ts
const record = await schedules.get('daily-digest-9am')
```

### `schedules.update(id, input)`

Patch `cron`, `enabled`, or `target`:

```ts
await schedules.update('daily-digest-9am', {
  cron: '15 9 * * *',
  enabled: true,
})
```

### `schedules.enable(id)` and `schedules.disable(id)`

Toggle whether a Runtime Schedule should run:

```ts
await schedules.disable('daily-digest-9am')
await schedules.enable('daily-digest-9am')
```

### `schedules.delete(id)`

Delete a Runtime Schedule record:

```ts
await schedules.delete('daily-digest-9am')
```

## Runtime Schedule Types

```ts
type RuntimeScheduleRecord = {
  createdAt: Date
  cron: string
  enabled: boolean
  id: string
  target: ScheduleTargetName
  updatedAt: Date
}
```

```ts
type RuntimeScheduleCreateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> = {
  cron: string
  enabled?: boolean
  id?: string
  target: TTarget
}
```

```ts
type RuntimeScheduleUpdateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> = {
  cron?: string
  enabled?: boolean
  target?: TTarget
}
```

## Agent Schedule Helpers

`@vitehub/agent` exports one `schedule()` helper with two v1 shapes.

### Inline Agent Schedules

```ts
schedule({
  schedules: [
    '0 9 * * *',
    { cron: '0 17 * * 1-5', id: 'weekday-summary' },
  ],
})
```

String entries derive ids from cron expressions. Object entries can set explicit ids.

### Schedule Capability Tools

```ts
schedule({
  mode: 'write',
  policy: 'require-approval',
  targets: ['daily-digest'],
})
```

`mode: 'read'` exposes `schedule_read` for `targets`, `list`, and `get`. `mode: 'write'` also exposes `schedule_edit` for `create`, `update`, `enable`, `disable`, and `delete`.

`policy` controls write-tool approval behavior and defaults to `require-approval`.

## Errors

Schedule validation and lookup failures throw `ScheduleError`.

Useful fields include:

| Field | Description |
| --- | --- |
| `message` | Human-readable failure message. |
| `code` | Stable error code when available. |
| `httpStatus` | Suggested HTTP status when available. |
| `details` | Validation or lookup diagnostics when available. |
