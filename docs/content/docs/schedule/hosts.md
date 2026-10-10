---
title: Schedule hosts
description: Understand Schedule Provider Output, development inspection, Runtime Schedule wake drivers, and production checks.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

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

## Inspect Runtime Schedules during development

`hubSchedule()` contributes the `vitehub schedule` CLI namespace. Start the Vite Development Server, then list, read, run, enable, or disable Runtime Schedules from another terminal.

```bash [Terminal]
pnpm vitehub schedule list
pnpm vitehub schedule runs weekday-report --limit 5 --json
pnpm vitehub schedule run-runtime weekday-report
```

The commands use the same Schedule stores and registry as the running server. The list shows the enabled state, the next due time in the Schedule time zone, and the last run. When no wake driver is installed, the output says that due times do not start runs in this runtime. Read [CLI](/docs/development/cli#inspect-and-control-runtime-schedules) for every command and option.

The Console Schedules page shows the same Runtime Schedules and their run history, next to the discovered Schedule Definitions. It reads the stores on each request and is read-only. Set `console: { enabled: false }` on a Runtime Schedule to hide it in the Console.

Both surfaces redact values under secret-named keys in Schedule input, and credentials in URLs, bearer tokens, and secret assignments in error messages.

| Host | `vitehub schedule` | Console Schedules page |
| --- | --- | --- |
| Vite + Nitro | Supported. The endpoint forwards each operation into the Nitro dev environment. | Definitions and Runtime Schedules. |
| Nuxt | Not supported. Nitro does not run in the Vite process. | Definitions and Runtime Schedules. |
| Plain Vite without Nitro | Not supported. The endpoint returns status 501. | Not available. |
| Deployed runtime | Not exposed. The endpoint exists only on the Development Server. | Definitions and Runtime Schedules, when the Console is enabled. |

Memory stores lose Runtime Schedules and runs when the runtime restarts. Configure KV stores to keep them.

## Connect a Runtime Schedule wake driver

Host integrations use a wake driver when the host can create and remove native schedule registrations at runtime.

```ts [server/runtime/schedule.ts]
import { installScheduleRuntime } from '@vite-hub/schedule/runtime/driver'

const controller = await installScheduleRuntime({
  createDriver: context => hostScheduler.driver(context),
  registry: scheduleRegistry,
  runtimeScheduleStore,
  scheduleRunStore,
  staticRegistry: scheduleRegistry,
})
```

`createDriver(context)` returns a driver with `reconcile(schedules)`. Pass `staticRegistry` when the driver also schedules discovered Static Schedule Definitions. Each reconciliation then receives those definitions with the complete stored Runtime Schedule snapshot, including disabled records. Installation waits for the first reconciliation.

The installed runtime processes Runtime Schedule creates, updates, and deletes one at a time. It saves each change before reconciling the wake driver. If reconciliation fails, ViteHub restores the previous record and rejects the change. Manual `schedules.run()` calls execute immediately and don't reconcile the driver.

When the host fires a native wake, call `context.wake({ scheduleId, scheduledAt })` with the exact stored Runtime Schedule id and occurrence time. Call `controller.close()` during host shutdown to release process resources; closing does not delete definitions, schedules, or run history.

Use `createProcessScheduleWakeDriver()` from `@vite-hub/schedule/runtime/process` when a custom long-running host wants the same in-process wake behavior without generated Nitro wiring.

`startScheduleRunner()` has been removed. Existing self-hosted processes must install `createProcessScheduleWakeDriver()` through `installScheduleRuntime()` and await `controller.close()` during host shutdown.

Static provider output remains build-time configuration; selecting the Process Runtime also executes discovered Static Schedule Definitions without requiring provider output.

## Production checks

Schedule Runs, Schedule Run Attempts, retry policy, overlap policy, and dedupe policy belong to Schedule. Naming a policy does not imply every policy is configurable in the first version.

Static Schedule Definitions and Provider Wake output remain UTC. Runtime Schedules use UTC by default and can persist an IANA `timeZone` when local clock time must follow daylight-saving changes.
