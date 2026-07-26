# @vite-hub/schedule

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Schedule" src="https://img.shields.io/badge/Schedule-cron%20runtime-0284c7?style=flat-square">
</p>

`@vite-hub/schedule` keeps cron definitions and runtime schedules behind one schedule registry.

## Install

```sh
pnpm add @vite-hub/schedule
```

Add `@vite-hub/kv` when using the default KV-backed stores or the generated Process Runtime. Static Schedules, memory stores, and custom `ScheduleKVStorage` implementations do not require it.

## Minimal API

```ts
// server/schedules/daily-report.ts
import { defineSchedule } from "@vite-hub/schedule"

export default defineSchedule({
  cron: "0 8 * * *",
  allowRuntimeSchedules: true,
  handler: async ({ scheduledAt }) => {
    console.log(`Generating daily report for ${scheduledAt.toISOString()}`)
  },
})
```

```ts
// server/schedules/report.ts
import { defineScheduleTarget } from "@vite-hub/schedule"

export default defineScheduleTarget<{ prompt: string }>({
  handler: async ({ input }) => {
    if (input) await generateReport(input.prompt)
  },
})
```

```ts
// server/api/schedules.post.ts
import { schedules } from "@vite-hub/schedule/runtime"
import { defineEventHandler } from "h3"

export default defineEventHandler(() => {
  return schedules.create({
    cron: "30 3 * * 1",
    input: { prompt: "Summarize yesterday" },
    target: "report",
    timeZone: "Europe/Copenhagen",
  })
})
```

Runtime Schedule updates preserve `timeZone` when it is omitted; set it to `UTC` to reset UTC evaluation. DST gaps skip missing local occurrences, and DST overlaps run both repeated instants.

```ts
// vite.config.ts
import { hubSchedule } from "@vite-hub/schedule/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubSchedule({
      runtime: {
        driver: "process",
        prefix: "my-app:schedule",
      },
    }),
  ],
})
```

The explicit `process` runtime generates Nitro wiring for a long-running process. It runs discovered Static Schedule Definitions and persisted Runtime Schedules through one driver queue, creates both stores through the default KV store configured by `hubKv()`, applies the Schedule prefix, and closes the driver with Nitro. The defaults are prefix `vitehub:schedule`, `intervalMs: 60_000`, and `concurrency: 1`; the interval cannot exceed the one-minute cron resolution. `providerOutput` remains independent, so static provider wake output can be enabled or disabled separately.

Run exactly one long-lived process or replica with this driver. The KV run store records occurrences but does not provide distributed leader election or locking. Do not select the process driver for request-scoped or serverless hosts that may stop between requests. Those hosts need a provider or host wake integration through `@vite-hub/schedule/runtime/driver`.

## Vite Integration

Use `hubSchedule()` in Vite to discover `server/schedules/<name>.ts` and `src/<name>.schedule.ts`. `defineSchedule()` declarations can produce provider cron output, including [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs/). Cronless `defineScheduleTarget()` declarations are available only to Runtime Schedules and never emit static provider output. For Nitro apps on Cloudflare, Schedule Provider Wake writes generated `.vitehub/nitro/schedule/*` files so Nitro can register the `cloudflare:scheduled` runtime hook and emit `cloudflare.wrangler.triggers.crons` during standalone `nitro build`. In Nuxt apps, install `@vite-hub/schedule/nuxt` so the same Provider Wake output is merged into Nuxt's top-level Nitro config. In automatic mode, `server/schedules/*` routes through Nitro Provider Wake while suffix schedules keep standalone provider output.

Runtime Schedule `input` is opaque to Schedule. Create stores a snapshot; update replaces the complete snapshot when `input` is provided and preserves it when omitted. The configured store must support the value's serialization requirements.

When a host owns its own Cloudflare scheduled-event bridge, use the runtime helper instead of reimplementing registry matching:

```ts
import scheduleRegistry from "#vitehub/schedule/registry"
import { executeCloudflareStaticSchedules } from "@vite-hub/schedule/runtime/static"

export default {
  async scheduled(event) {
    await executeCloudflareStaticSchedules(event, { registry: scheduleRegistry })
  },
}
```

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).

## Runtime Wake Drivers

Host integrations can connect dynamic Runtime Schedules to a native scheduler through `@vite-hub/schedule/runtime/driver`:

```ts
import { installScheduleRuntime } from "@vite-hub/schedule/runtime/driver"

const controller = await installScheduleRuntime({
  createDriver: context => hostScheduler.driver(context),
  registry: scheduleRegistry,
  runtimeScheduleStore,
  scheduleRunStore,
})
```

The driver receives the complete stored Runtime Schedule snapshot, including disabled records. Installation finishes only after the initial snapshot is reconciled. Later creates, updates, and deletes persist first, reconcile serially, and roll back the stored record if host reconciliation fails. A native wake calls `context.wake({ scheduleId, scheduledAt })`; `controller.close()` releases driver resources without deleting schedule state.

Long-running hosts can use `createProcessScheduleWakeDriver()` from `@vite-hub/schedule/runtime/process` when they install the runtime directly. It keeps wake registration inside the current process; it does not install cron, systemd, or another operating-system scheduler.

`startScheduleRunner()` has been removed. Existing self-hosted processes should install `createProcessScheduleWakeDriver()` through `installScheduleRuntime()` as shown above, then await `controller.close()` during host shutdown.

Learn more at [vitehub.dev](https://vitehub.dev).
