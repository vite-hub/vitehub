# @vite-hub/schedule

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fschedule&icon=npm)](https://npmx.dev/package/@vite-hub/schedule)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fschedule&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/schedule)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/schedule` discovers recurring work, generates cron output for supported hosts, and can run Static Schedule Definitions in one long-lived process.

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

Direct integrations use `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, and `@vite-hub/schedule/vite`. Add Vite when the project uses `hubSchedule()`. Add `@vite-hub/kv` when using the KV Schedule Run store through `@vite-hub/schedule/runtime/kv` or the generated Process Runtime. Static Schedule Definitions, memory stores, and custom `ScheduleKVStorage` implementations do not require KV.

Both packages require Node.js 24.15 or newer.

## Run one occurrence

This smoke test uses the direct owner-package import. If the application installed `vite-hub`, use `vite-hub/schedule` and `vite-hub/schedule/runtime`. It defines a Static Schedule and executes one fixed occurrence without a Vite config or hosted scheduler.

```ts
import { defineSchedule } from "@vite-hub/schedule";
import { executeStaticSchedule } from "@vite-hub/schedule/runtime";

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

Static Schedule Definitions use five-field cron expressions. The cron uses UTC unless the definition sets `timeZone` to an IANA name, such as `Europe/Madrid`. Only the Process Runtime evaluates `timeZone`. Provider cron output supports only UTC, so a build that generates Provider Output fails with `SCHEDULE_R0003` when a definition sets a `timeZone` other than `UTC`.

The integration can generate host-specific output for Cloudflare Cron Triggers, Vercel Cron Jobs, Netlify Scheduled Functions, standalone `Deno.cron`, and Nitro's Cloudflare schedule hook. Host selection, local execution, deployment proof, limits, and billing still come from the selected host. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before deploying.

Applications that use the framework distribution register Schedule through `vitehub({ preset, schedule: true })` and import the definition helper from `vite-hub/schedule`. The Deno framework preset currently rejects Schedule because standalone Deno cron output sits outside its generated Nitro entrypoint. Use the direct Schedule integration for that output.

Direct Nuxt projects can register `@vite-hub/schedule/nuxt` instead of `hubSchedule()`. The module installs the Vite integration and merges Schedule output into Nitro config.

## Understand time zones

Write `timeZone` as a string literal, because the build and the Console read it from the source file. Abbreviations such as `PST` and numeric offsets such as `+01:00` are rejected. To use a local clock time, use the Process Runtime. Otherwise, remove `timeZone` and write the cron in UTC.

During a daylight-saving gap, a local time that does not exist does not run that day. A local time that occurs twice runs once, at its first occurrence, when the cron sets a fixed minute and hour. A cron with `*` in the minute or hour field runs on elapsed time, so it also runs in the repeated hour.

## Run schedules in one process

The generated Process Runtime runs each Static Schedule Definition on its cron inside the Node.js process. It records Schedule Runs in the default KV store configured by `hubKv()`. Configure it only for one long-lived replica:

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

Its defaults are prefix `vitehub:schedule`, scan interval `60_000` milliseconds, concurrency `1`, and catch-up `catchUpMs` of one hour. The interval cannot exceed one minute. `concurrency` limits runs only inside that process. After a restart, the runtime runs the due minutes that no process checked, within `catchUpMs`, for each Schedule that already has a run. Run ids are deterministic, so a minute that already ran does not run again. The KV run store does not provide distributed leader election or locking, so multiple replicas can execute the same work. Request-scoped and serverless hosts must not use the Process Runtime because the process may stop between requests.

With the Process Runtime, the default `providerOutput: "auto"` emits no host Provider Output, so the process owns Static Schedule wakes. Set `providerOutput: "standalone"` or `"nitro"` to move Static Schedule wakes to that Provider Output. `providerOutput: false` records the same wake ownership as `"auto"` in this configuration.

A custom long-running host can call `installProcessScheduleRuntime({ registry, scheduleRunStore })` from `@vite-hub/schedule/runtime/process`. Call and await `controller.close()` during shutdown. It waits for active runs and their `waitUntil()` work, then stops the timer. It does not delete Schedule Definitions or run history. The generated Nitro Process Runtime registers the same close operation with ViteHub shutdown. See [graceful shutdown](../runtime/README.md).

## Choose storage

Schedule Runs record manual runs and Process Runtime runs. Provider cron output runs the handler without a run record.

The memory store is the default for direct calls. It is process-local and loses Schedule Run history on restart. Use `createKVScheduleRunStore({ kvStore })` when runs must survive a restart. The factory requires an explicit `ScheduleKVStorage`. To use ViteHub KV, install `@vite-hub/kv` and import the adapter explicitly:

```ts
import { createKVScheduleRunStore } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Generated Process Runtime wiring selects this adapter automatically. Applications using the framework can import it from `vite-hub/schedule/runtime/kv`. Use `setScheduleRunStore(store)` to install a custom `ScheduleRunStore`.

## Run and inspect schedules

`hubSchedule()` contributes the `schedule.runs`, `schedule.attempts`, and `schedule.run` operations. They are the `vitehub schedule runs <id> [--limit <n>]`, `attempts <runId>`, and `run <name>` commands, and the Console runs them too. Each command accepts `--json` and `--url`. Without `--url` the command calls the dev server of the project, whose Nitro runtime owns the same stores and registry as the running app. The operations import from `@vite-hub/schedule/operations`.

Set `manual: true` on a Static Schedule Definition to allow an on-demand run, then invoke it with `vitehub schedule run <name>`. The name is the discovered schedule file name. Add `--url <app-url>` with the Console credentials to run it on a deployment that enables `console.invoke`. A CI job can post a signed dispatch (`vitehub secret derive vitehub:dispatch`) to `/_vitehub/schedules/run` instead. Server code can call `runSchedule(name, { registry })` from `@vite-hub/schedule/runtime`. Each manual run gets a new `srun_manual_` id.

Discovery reads `manual` as a literal boolean from directly exported Definitions. Use identifier keys or quoted keys without escape sequences. Spreads, computed keys, escaped keys, and metadata getters or methods fail with the source file and line.

The Console Schedules section lists Schedule Definitions with their cron, time zone, and manual state. It reads them at build time. Use `vitehub schedule runs <name>` to list the runs that the runtime recorded. The CLI and the Console redact credentials in error messages.

## Import runtime helpers

The main `@vite-hub/schedule` entry exports `defineSchedule` and public types. Import execution, storage, and runtime state helpers from `@vite-hub/schedule/runtime`. Import `installProcessScheduleRuntime` from `@vite-hub/schedule/runtime/process`. Import `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` when writing a build integration. Applications use `vite-hub/schedule` and `vite-hub/schedule/runtime`.

Static Schedule execution logs each failed handler as `[vitehub:schedule] Schedule "<name>" failed` with the message, stack, status, and cause chain. The other schedules on the same cron still finish. The run rejects with the error, or with an `AggregateError` when several failed.

`executeSchedule()` accepts `captureHandlerFailure: true` to return the persisted failed run after a handler error. Pre-execution guards still throw.

## Documentation and support

- Read the [Schedule guide](https://vitehub.dev/docs/schedule) for every public import, Runtime Helper, store, and Vite option.
- Check [Provider Output](https://vitehub.dev/docs/reference/provider-output) for generated files and deployment inspection.
- Check [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for current proof and host qualifications.
- Report package problems in the [ViteHub issue tracker](https://github.com/vite-hub/vitehub/issues).

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).
