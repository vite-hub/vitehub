# @vite-hub/schedule

`@vite-hub/schedule` discovers recurring work, generates cron output for supported hosts, and manages recurring schedules that an application creates while it runs.

## Choose the package

Install `vite-hub` for an application. It includes Schedule and exposes application imports under `vite-hub/schedule`.

```sh
pnpm add vite-hub
```

Enable Schedule with the framework integration and import application helpers from its feature path:

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "cloudflare", schedule: true })],
});
```

```ts
import { defineSchedule } from "vite-hub/schedule";
```

Install the owner package directly when a library or custom integration needs Schedule without the framework distribution.

```sh
pnpm add @vite-hub/schedule
```

Direct integrations use `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, and `@vite-hub/schedule/vite`. Add Vite when the project uses `hubSchedule()`. Add `@vite-hub/kv` when using the default KV-backed stores or the generated Process Runtime. Static Schedule Definitions, memory stores, and custom `ScheduleKVStorage` implementations do not require KV.

Both packages require Node.js 24.15 or newer.

## Choose the schedule kind

| Kind                       | Create it with                                       | Use it when                                                                                                 |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Static Schedule Definition | `defineSchedule()` in a discovered source file       | The cron is part of the deployment and can produce host Provider Output.                                    |
| Schedule Target            | `defineScheduleTarget()` in a discovered source file | Runtime Schedules need a named handler with no build-time cron. A target never produces static cron output. |
| Runtime Schedule           | `schedules.create()` in server code                  | The application must create, update, pause, or delete a recurring schedule while it runs.                   |

A Runtime Schedule must name a Schedule Target. A Static Schedule Definition can also become a target when it sets `allowRuntimeSchedules: true`.

## Run one occurrence

This smoke test uses the direct owner-package import. If the application installed `vite-hub`, import the same names from `vite-hub/schedule`. It defines a Static Schedule and executes one fixed occurrence without a Vite config or hosted scheduler.

```ts
import { defineSchedule, executeStaticSchedule } from "@vite-hub/schedule";

const dailyReport = defineSchedule({
  cron: "0 8 * * *",
  handler({ scheduledAt }) {
    console.log(`Report scheduled for ${scheduledAt.toISOString()}`);
  },
});

const run = await executeStaticSchedule({
  cron: dailyReport.cron,
  definition: dailyReport,
  name: "daily-report",
  scheduledAt: new Date("2026-08-27T08:00:00.000Z"),
});

console.log(run.status);
```

```txt
Report scheduled for 2026-08-27T08:00:00.000Z
succeeded
```

The example uses the default in-memory Schedule Run store. It proves the handler and run bookkeeping, but it does not install a recurring wake or generate Provider Output.

## Discover a static schedule

Register the direct owner-package integration in Vite.

```ts
// vite.config.ts
import { hubSchedule } from "@vite-hub/schedule/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubSchedule()],
});
```

Then export a definition from `server/schedules/<name>.ts` or `src/<name>.schedule.ts`.

```ts
// server/schedules/daily-report.ts
import { defineSchedule } from "@vite-hub/schedule";

export default defineSchedule({
  cron: "0 8 * * *",
  async handler({ scheduledAt, waitUntil }) {
    await sendDailyReport(scheduledAt);
    waitUntil(recordDelivery());
  },
});
```

Static Schedule Definitions use five-field UTC cron expressions. They cannot set `timeZone`. The integration can generate host-specific output for Cloudflare Cron Triggers, Vercel Cron Jobs, Netlify Scheduled Functions, standalone `Deno.cron`, and Nitro's Cloudflare schedule hook. Host selection, local execution, deployment proof, limits, and billing still come from the selected host. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before deploying.

Applications that use the framework distribution register Schedule through `vitehub({ preset, schedule: true })` and import the definition helper from `vite-hub/schedule`. The Deno framework preset currently rejects Schedule because standalone Deno cron output sits outside its generated Nitro entrypoint. Use the direct Schedule integration for that output.

Direct Nuxt projects can register `@vite-hub/schedule/nuxt` instead of `hubSchedule()`. The module installs the Vite integration and merges Schedule output into Nitro config.

## Create a Runtime Schedule

Define a cronless target for work that runs only through Runtime Schedules.

```ts
// server/schedules/report.ts
import { defineScheduleTarget } from "@vite-hub/schedule";

export default defineScheduleTarget<{ prompt: string }>({
  async handler({ input }) {
    if (input) await generateReport(input.prompt);
  },
});
```

Before creating the recurring record, install the Schedule runtime so it can load the discovered target registry and reconcile stored schedules. A custom host calls `installScheduleRuntime()` from `@vite-hub/schedule/runtime/driver` with its wake driver. A generated Process Runtime does this during application startup.

After runtime installation completes, create the recurring record from server code.

```ts
import { schedules } from "@vite-hub/schedule/runtime";

const report = await schedules.create({
  cron: "30 8 * * 1-5",
  id: "weekday-report",
  input: { prompt: "Summarize yesterday" },
  target: "report",
  timeZone: "Europe/Copenhagen",
});

console.log(report.id);
```

The installed runtime can supply a native wake driver, or one long-lived process can install `createProcessScheduleWakeDriver()` from `@vite-hub/schedule/runtime/process`.

Static provider cron output does not automatically wake Runtime Schedules. Provider-backed Runtime Schedules need a host-owned wake driver. Request-scoped and serverless hosts must not use the Process Runtime because the process may stop between requests.

## Understand time zones

Static Schedule Definitions and their Provider Output always use UTC. Runtime Schedules use UTC when `timeZone` is absent and accept IANA time-zone names when the cron must follow local clock time.

Omitting `timeZone` during an update preserves the stored zone. Set it to `UTC` to return to UTC evaluation. Numeric offsets such as `+01:00` are rejected. During a daylight-saving gap, ViteHub skips a local time that does not exist. During an overlap, both distinct instants that share the repeated local time are due.

## Choose storage and wake ownership

Memory stores are the default for direct calls. They are process-local and lose Runtime Schedules and Schedule Run history on restart. Use `createKVRuntimeScheduleStore()` and `createKVScheduleRunStore()` when those records must survive a restart. The default KV-backed stores require `@vite-hub/kv`; custom stores can implement the public store interfaces instead.

The generated Process Runtime creates both stores through the default KV store configured by `hubKv()`. It scans inside the Node.js process and runs discovered Static Schedule Definitions with stored Runtime Schedules. Configure it only for one long-lived replica:

```ts
import { hubKv } from "@vite-hub/kv/vite";
import { hubSchedule } from "@vite-hub/schedule/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    hubKv(),
    hubSchedule({
      runtime: {
        driver: "process",
        prefix: "my-app:schedule",
      },
    }),
  ],
});
```

Its defaults are prefix `vitehub:schedule`, scan interval `60_000` milliseconds, and concurrency `1`. The interval cannot exceed one minute. `concurrency` limits wake delivery only inside that process. The KV run store records occurrences but does not provide distributed leader election or locking, so multiple replicas can execute the same work. A stopped process does not backfill minutes that it missed.

Process Runtime selection and static `providerOutput` selection are independent. Set `providerOutput: false` when only the process should wake Static Schedules.

`installScheduleRuntime()` returns only after its driver reconciles the complete stored snapshot, including disabled Runtime Schedules. Later creates, updates, and deletes persist first and reconcile one at a time. If host reconciliation fails, ViteHub restores the previous stored record and rejects the change.

When a custom host installs a wake driver, call and await `controller.close()` during shutdown. Closing stops new wakes, drains active wakes and `waitUntil()` work, and releases driver resources. It does not delete Schedule Definitions, Runtime Schedules, or run history. The generated Nitro Process Runtime connects the same close operation to Nitro shutdown and process termination signals.

## Documentation and support

- Read the [Schedule guide](https://vitehub.dev/docs/server-primitives/schedule) for every public import, Runtime Helper, store, wake driver, and Vite option.
- Check [Provider Output](https://vitehub.dev/docs/reference/provider-output) for generated files and deployment inspection.
- Check [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for current proof and host qualifications.
- Report package problems in the [ViteHub issue tracker](https://github.com/vite-hub/vitehub/issues).

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).
