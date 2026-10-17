---
title: Schedule configuration
description: Configure the Schedule Vite Integration, Schedule Definitions, and storage.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSchedule(),
    nitro(),
  ],
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectRoot` | `string` | ViteHub project root | Resolves discovered schedule files and generated registry output from a custom project root. |

Use `createScheduleNitroConfig()` when a Nitro integration owns config merging. It returns the Nitro config with the Schedule Nitro module that registers each Static Schedule as a Nitro scheduled task. Read [Schedule hosts](/docs/schedule/hosts) for how each host fires the tasks.

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
| `manual` | `boolean` | No | Allows `vitehub schedule run` and Console invocation to run this definition outside its cron. |

Set `manual: true` to enable on-demand runs for a Static Schedule Definition:

```ts [server/schedules/daily-report.ts]
export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  async handler() {
    await sendDailyReport()
  },
})
```

Run it from a ViteHub development server with `vitehub schedule run daily-report`. The command uses the discovered file name as the definition name and supports `--json`; deployments can invoke the same definition through the Console.

Write `manual` as a literal `true` or `false` value in the directly exported definition. Use an identifier key or a quoted key without escape sequences. Discovery does not evaluate constants, spreads, computed properties, or getters. Unsupported forms fail with the source file and line instead of silently omitting manual runs.

`ScheduleRunContext` includes `id`, `scheduledAt`, `waitUntil`, optional `attemptId`, optional `runId`, optional `scheduleId`, and optional `target`, the name of the Schedule Definition that runs.

Use `waitUntil(promise)` for consequential work that can outlive the handler body. Direct and local execution settles registered work before recording the Schedule Run result; a rejection fails the run with the same diagnostics as a handler rejection. A Nitro scheduled task passes the host `waitUntil` when the host provides one, such as Cloudflare or Vercel. The host then keeps the registered work after the handler returns.

## Contribute Schedules from a package

A package can add a Schedule from its own Vite plugin, so applications do not write `server/schedules/<name>.ts` for it. Add `vitehub.schedules` to the plugin object. Each entry has a `name` and a `definition` that names the module and export of a `defineSchedule()` result:

```ts [my-package/vite.ts]
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import type { ScheduleContributingPlugin } from '@vite-hub/schedule/vite'

export function myPackage(): Plugin & ScheduleContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      async schedules({ projectRoot }) {
        const module = join(projectRoot, '.vitehub/my-package/publish-schedule.ts')
        await mkdir(dirname(module), { recursive: true })
        await writeFile(module, [
          `import { defineSchedule } from '@vite-hub/schedule'`,
          `import { publishDue } from 'my-package/server'`,
          `export default defineSchedule({ cron: '*/5 * * * *', manual: true, handler: () => publishDue() })`,
          '',
        ].join('\n'))
        return [{
          name: 'my-package/publish',
          definition: { module, export: 'default' },
          reason: 'Publishes scheduled documents.',
        }]
      },
    },
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Schedule name for `vitehub schedule run <name>` and provider output. Letters, numbers, `.`, `_`, `-`, and `/`. |
| `definition.module` | `string` | Absolute file path or `file:` URL of the module. Schedules do not accept package specifiers, see below. |
| `definition.export` | `string` | Must be `default`, the export that holds `defineSchedule()`. Defaults to `default`. |
| `reason` | `string` | Optional. Why the package adds the Schedule. `vitehub inspect definitions` and the Console show it. |

The build reads the cron and the `manual` option from source without running the module, the same as discovered files. The Definition module therefore follows the [file rules](#schedule-definition-options): a direct `export default defineSchedule({ ... })` with literal options. That is why `definition.module` must be a file and `definition.export` must be `default`: bundled package output rarely keeps that form. Generate the module under `.vitehub/` in the project, as above, or ship it as source and pass `fileURLToPath(new URL('./publish-schedule.ts', import.meta.url))`.

`vitehub.schedules` accepts an array or a factory. The factory receives `{ root, projectRoot, serverDirs }`, where `root` is the Vite root, and can be async. The Schedule plugin can read contributions before your plugin's `config` hook runs, so compute them in the factory, not in your own hooks. The factory runs once per discovery pass and must return the same result each time. ViteHub sorts contributions by name.

A contributed Schedule behaves like a `server/schedules/` file on every host. It becomes a Nitro scheduled task. It is in the registry that `vitehub schedule run` loads, `vitehub inspect definitions`, and the Console Schedules section. Inspection shows the contributing plugin and its reason.

Each Schedule name has one Definition. If a contribution reuses the name of a discovered file or of another plugin's contribution, the build fails with `SCHEDULE_B0006`, and the message names both sources or both plugins. An invalid entry fails with `SCHEDULE_B0007`, which is also used when the Definition module does not exist. A module without a default export of `defineSchedule()` fails with `SCHEDULE_B0005`.

`collectScheduleContributions(plugins, context)` from `@vite-hub/schedule/vite` returns the validated contributions. Use it when another build step needs the same list.

## Storage

Schedule Runs record manual runs and the runs that Nitro scheduled tasks start. The default store keeps runs in memory, so each server instance has its own history.

| Store | Configure with | Nuance |
| --- | --- | --- |
| Memory Schedule Run Store | `createMemoryScheduleRunStore()` | Default in-process run history; useful for tests and local runtime only. |
| KV Schedule Run Store | `createKVScheduleRunStore({ kvStore, prefix? })` | Persists Schedule Runs and attempts through KV-compatible storage. |
| Custom Store | `setScheduleRunStore(store)` | Implement `ScheduleRunStore` directly. |

The KV factory requires an explicit `ScheduleKVStorage`. To use ViteHub KV, pass `scheduleKVStorage` from `vite-hub/schedule/runtime/kv` (or `@vite-hub/schedule/runtime/kv` for standalone consumers). Standalone consumers must install `@vite-hub/kv` when using that adapter. Static schedules, memory stores, and custom storage do not need the package.

```ts
import { createKVScheduleRunStore } from "vite-hub/schedule/runtime"
import { scheduleKVStorage } from "vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

