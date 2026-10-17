# @vite-hub/schedule

`@vite-hub/schedule` discovers recurring work in files, generates cron output for supported hosts, and runs it in a long-lived Node process when the host has no cron.

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

Direct integrations use `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, and `@vite-hub/schedule/vite`. Add Vite when the project uses `hubSchedule()`. Add `@vite-hub/kv` when using the KV-backed Schedule Run store or the generated Process Runtime. Static Schedule Definitions, memory stores, and custom `ScheduleKVStorage` implementations do not require KV.

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

Static Schedule Definitions use five-field cron expressions in UTC, or in the IANA `timeZone` that the definition sets. The integration can generate host-specific output for Cloudflare Cron Triggers, Vercel Cron Jobs, Netlify Scheduled Functions, standalone `Deno.cron`, and Nitro's Cloudflare schedule hook. Host selection, local execution, deployment proof, limits, and billing still come from the selected host. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before deploying.

Applications that use the framework distribution register Schedule through `vitehub({ preset, schedule: true })` and import the definition helper from `vite-hub/schedule`. The Deno framework preset currently rejects Schedule because standalone Deno cron output sits outside its generated Nitro entrypoint. Use the direct Schedule integration for that output.

Direct Nuxt projects can register `@vite-hub/schedule/nuxt` instead of `hubSchedule()`. The module installs the Vite integration and merges Schedule output into Nitro config.

Packages can contribute a Schedule from their own Vite plugin with `vitehub.schedules`. Each entry has the shared contribution shape `{ name, definition: { module, export }, reason? }`:

```ts
const plugin = {
  name: "my-package/vite",
  vitehub: {
    schedules: ({ projectRoot }) => [{
      name: "my-package/publish",
      definition: { module: join(projectRoot, ".vitehub/my-package/publish-schedule.ts"), export: "default" },
      reason: "Publishes scheduled documents.",
    }],
  },
}
```

The module must be an absolute file path or `file:` URL, and the export must be `default`. The module follows the file rules: `export default defineSchedule({ cron: "...", handler })` with literal options, because the build reads it from source. Contributed Schedules get the same provider output, Process Runtime registration, `vitehub schedule run` support, inspection, and Console records as `server/schedules/` files. A name used by both a file and a contribution fails the build with `SCHEDULE_B0006`.

## Run Static Schedules in one Node process

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

Static Schedule Definitions and Runtime Schedules use UTC when `timeZone` is absent and accept IANA time-zone names when the cron must follow local clock time.

```ts
export default defineSchedule({
  cron: "0 8 * * *",
  timeZone: "Europe/Madrid",
  handler: sendMorningBrief,
});
```

Only the process driver evaluates the `timeZone` of a Static Schedule Definition. Write it as a string literal, because the build and the Console read it from the source file. Provider cron output for Cloudflare, Vercel, Netlify, and Deno supports only UTC, so a build that generates provider output fails when a Static Schedule Definition sets a `timeZone` other than `UTC`.

Omitting `timeZone` during an update preserves the stored zone. Set it to `UTC` to return to UTC evaluation. Numeric offsets such as `+01:00` are rejected. During a daylight-saving gap, ViteHub skips a local time that does not exist. During an overlap, a cron with a fixed minute and hour runs once, at the first instant of the repeated local time. A cron with `*` in the minute or hour field runs on elapsed time, so both instants are due.

## Choose storage and wake ownership

Memory stores are the default for direct calls. They are process-local and lose Runtime Schedules and Schedule Run history on restart. Use `createKVRuntimeScheduleStore({ kvStore })` and `createKVScheduleRunStore({ kvStore })` when those records must survive a restart. Both factories require an explicit `ScheduleKVStorage`. Static schedules, memory stores, and custom storage do not require `@vite-hub/kv`.

To use ViteHub KV, install `@vite-hub/kv` and import the adapter explicitly:

```ts
import { createKVRuntimeScheduleStore, createKVScheduleRunStore } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"

const runtimeScheduleStore = createKVRuntimeScheduleStore({ kvStore: scheduleKVStorage })
const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Migration: replace factory calls without `kvStore` with the explicit adapter shown above. Generated Process Runtime wiring selects this adapter automatically. Applications using the framework can import it from `vite-hub/schedule/runtime/kv`.

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

Its defaults are prefix `vitehub:schedule`, scan interval `60_000` milliseconds, and concurrency `1`. The interval cannot exceed one minute. `concurrency` limits runs only inside that process. The KV run store records occurrences but does not provide distributed leader election or locking, so multiple replicas can execute the same work. After a restart the runtime runs the minutes that no process checked, within one hour, for each Schedule that already has a run. Request-scoped and serverless hosts must not use the Process Runtime because the process may stop between requests.

With the Process Runtime, the default `providerOutput: "auto"` emits no host Provider Output, so the process owns Static Schedule wakes. Set `providerOutput: "standalone"` or `"nitro"` to move Static Schedule wakes to that Provider Output. `providerOutput: false` records the same wake ownership as `"auto"` in this configuration.

A custom long-running host calls `installProcessScheduleRuntime({ registry, scheduleRunStore })` from `@vite-hub/schedule/runtime/process`, then awaits `controller.close()` during shutdown. Closing stops new runs, drains active runs and `waitUntil()` work, and stops the timer. The generated Nitro Process Runtime connects the same close operation to Nitro shutdown and process termination signals.

## Understand time zones

Static Schedule Definitions and their Provider Output always use UTC.

## Choose storage

Schedule Runs record manual runs and Process Runtime runs. The memory store is the default for direct calls. It is process-local and loses run history on restart. Use `createKVScheduleRunStore({ kvStore })` when runs must survive a restart. The factory requires an explicit `ScheduleKVStorage`. Static schedules, memory stores, and custom storage do not require `@vite-hub/kv`.

To use ViteHub KV, install `@vite-hub/kv` and import the adapter explicitly:

```ts
import { createKVScheduleRunStore } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Generated Process Runtime wiring selects this adapter automatically. Applications using the framework can import it from `vite-hub/schedule/runtime/kv`.

## Run and inspect Schedules

`hubSchedule()` contributes the `vitehub schedule` CLI namespace: `run <name>`, `runs <name> [--limit <n>]`, and `attempts <runId>`. Each command accepts `--json`. The commands call a guarded endpoint that exists only on the Vite Development Server. The endpoint forwards each operation into the Nitro dev environment, so it reads the same Schedule Run store and registry as the running app. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 there.

Set `manual: true` on a Static Schedule Definition to allow an on-demand run, then invoke it with `vitehub schedule run <name>` or `runSchedule(name, { registry })` from `@vite-hub/schedule/runtime`. The name is the discovered schedule file name.

Discovery reads `manual` as a literal boolean from directly exported Definitions. Use an identifier key or a quoted key without escape sequences. Spreads, computed keys, escaped keys, and metadata getters or methods fail with the source file and line.

The Console Schedules section is a record table of the discovered Schedule Definitions. The CLI and the Console redact credentials in error messages.

## Import runtime helpers

The main `@vite-hub/schedule` entry exports `defineSchedule` and public types. Import execution, storage, and runtime state helpers from `@vite-hub/schedule/runtime`. Import `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` when writing a build integration. Applications use `vite-hub/schedule` and `vite-hub/schedule/runtime`.

`executeSchedule()` accepts `captureHandlerFailure: true` to return the persisted failed run after a handler error. Pre-execution guards still throw.

## Documentation and support

- Read the [Schedule guide](https://vitehub.dev/docs/schedule) for every public import, store, and Vite option.
- Check [Provider Output](https://vitehub.dev/docs/reference/provider-output) for generated files and deployment inspection.
- Check [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for current proof and host qualifications.
- Report package problems in the [ViteHub issue tracker](https://github.com/vite-hub/vitehub/issues).

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).
