---
title: Schedule configuration
description: Configure the Schedule Vite Integration, the Process Runtime, Schedule Definitions, and storage.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSchedule({
      runtime: {
        driver: 'process',
        prefix: 'my-app:schedule',
      },
    }),
  ],
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `providerOutput` | `ScheduleVitePluginOptions['providerOutput']` | `auto` | Controls generated provider cron output. Values: `auto`, `standalone`, `nitro`, `false`. |
| `projectRoot` | `string` | ViteHub project root | Resolves discovered schedule files and generated registry output from a custom project root. |
| `runtime` | `ScheduleProcessRuntimeOptions` | No runtime driver | Explicitly installs the generated Nitro Process Runtime. Accepts `driver: 'process'`, plus optional `prefix` (default `vitehub:schedule`), `intervalMs` (default `60_000`), and `concurrency` (default `1`). |

Use `createScheduleNitroConfig()` when a Nitro integration owns config merging and needs Schedule to return Nitro-ready provider output.

The Process Runtime imports the discovered registry and runs Static Schedule Definitions alongside persisted Runtime Schedules through one driver queue. It creates the Runtime Schedule and Schedule Run stores through the default KV store configured by `hubKv()`, applies the Schedule prefix to both, reports errors through Nitro, and closes the driver during Nitro shutdown. It scans once per minute with one concurrent wake unless configured otherwise, and `intervalMs` cannot exceed the one-minute cron resolution. This setting is orthogonal to `providerOutput`; selecting one does not infer the other.

::warning
The Process Runtime requires exactly one long-lived process or replica. The KV run store records occurrences but does not provide distributed leader election or locking. Do not use this driver on request-scoped or serverless hosts that may stop between requests. It scans inside the Node.js process and does not create cron, systemd, or another operating-system schedule.
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

Write `manual` and `allowRuntimeSchedules` as literal `true` or `false` values in the directly exported definition. Use identifier keys or quoted keys without escape sequences. Discovery does not evaluate constants, spreads, computed properties, or getters. Unsupported forms fail with the source file and line instead of silently omitting a runtime target.

`ScheduleRunContext` includes `id`, `scheduledAt`, `waitUntil`, optional `attemptId`, optional `runId`, optional Runtime Schedule id, optional Runtime Schedule target, and optional Runtime Schedule `input`.

Use `waitUntil(promise)` for consequential work that can outlive the handler body. Direct and local execution settles registered work before recording the Schedule Run result; a rejection fails the run with the same diagnostics as a handler rejection. An installed wake runtime instead retains registered work after the handler returns, reports rejection through its `onError` hook, and drains outstanding work when the runtime closes.

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
| `name` | `string` | Schedule name for `vitehub schedule run <name>`, provider output, and Runtime Schedule targets. Letters, numbers, `.`, `_`, `-`, and `/`. |
| `definition.module` | `string` | Absolute file path or `file:` URL of the module. Schedules do not accept package specifiers, see below. |
| `definition.export` | `string` | Must be `default`, the export that holds `defineSchedule()` or `defineScheduleTarget()`. Defaults to `default`. |
| `reason` | `string` | Optional. Why the package adds the Schedule. `vitehub inspect definitions` and the Console show it. |

The build reads the cron and the `manual` and `allowRuntimeSchedules` options from source without running the module, the same as discovered files. The Definition module therefore follows the [file rules](#schedule-definition-options): a direct `export default defineSchedule({ ... })` with literal options. That is why `definition.module` must be a file and `definition.export` must be `default`: bundled package output rarely keeps that form. Generate the module under `.vitehub/` in the project, as above, or ship it as source and pass `fileURLToPath(new URL('./publish-schedule.ts', import.meta.url))`.

`vitehub.schedules` accepts an array or a factory. The factory receives `{ root, projectRoot, serverDirs }`, where `root` is the Vite root, and can be async. The Schedule plugin can read contributions before your plugin's `config` hook runs, so compute them in the factory, not in your own hooks. The factory runs once per discovery pass and must return the same result each time. ViteHub sorts contributions by name.

A contributed Schedule behaves like a `server/schedules/` file on every host. Its cron is added to Cloudflare Cron Triggers, Vercel cron config, Netlify Scheduled Functions, and the Nitro wake plugin. The Node Process Runtime runs it. It is in the registry that `vitehub schedule run` loads, the generated `ScheduleTargetRegistry` types, `vitehub inspect definitions`, and the Console Schedules section. Inspection shows the contributing plugin and its reason. With `providerOutput: 'auto'`, contributed Schedules take the same delivery path as `server/schedules/` files.

Each Schedule name has one Definition. If a contribution reuses the name of a discovered file or of another plugin's contribution, the build fails with `SCHEDULE_B0006`, and the message names both sources or both plugins. An invalid entry fails with `SCHEDULE_B0007`, which is also used when the Definition module does not exist. A module without a default export of `defineSchedule()` fails with `SCHEDULE_B0005`.

`collectScheduleContributions(plugins, context)` from `@vite-hub/schedule/vite` returns the validated contributions. Use it when another build step needs the same list.

## Storage

| Store | Configure with | Nuance |
| --- | --- | --- |
| Memory Runtime Schedule Store | `createMemoryRuntimeScheduleStore()` | Default in-process behavior; useful for tests and local runtime only. |
| KV Runtime Schedule Store | `createKVRuntimeScheduleStore({ kvStore, prefix? })` | Persists Runtime Schedule records through a KV-compatible storage object. |
| Memory Schedule Run Store | `createMemoryScheduleRunStore()` | Default in-process run history; useful for tests and local runtime only. |
| KV Schedule Run Store | `createKVScheduleRunStore({ kvStore, prefix? })` | Persists Schedule Runs and attempts through KV-compatible storage. |
| Custom Store | `setRuntimeScheduleStore(store)`, `setScheduleRunStore(store)` | Implement `RuntimeScheduleStore` or `ScheduleRunStore` directly. |

Both KV factories require an explicit `ScheduleKVStorage`. To use ViteHub KV, pass `scheduleKVStorage` from `vite-hub/schedule/runtime/kv` (or `@vite-hub/schedule/runtime/kv` for standalone consumers). Standalone consumers must install `@vite-hub/kv` when using that adapter. Static schedules, memory stores, and custom storage do not need the package.

```ts
import { createKVRuntimeScheduleStore, createKVScheduleRunStore } from "vite-hub/schedule/runtime"
import { scheduleKVStorage } from "vite-hub/schedule/runtime/kv"

const runtimeScheduleStore = createKVRuntimeScheduleStore({ kvStore: scheduleKVStorage })
const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Migration: existing factory calls without `kvStore` must pass the adapter explicitly. Generated Process Runtime wiring selects the adapter automatically. Existing calls with custom `kvStore` objects are unchanged.
