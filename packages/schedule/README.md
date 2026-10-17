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

Direct integrations use `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, and `@vite-hub/schedule/vite`. Add Vite when the project uses `hubSchedule()`. Add `@vite-hub/kv` when using the KV-backed Schedule Run store. Static Schedule Definitions, memory stores, and custom `ScheduleKVStorage` implementations do not require KV.

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

The example uses the default in-memory Schedule Run store. It proves the handler and run bookkeeping, but it does not install a recurring wake.

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

Static Schedule Definitions use five-field UTC cron expressions. They cannot set `timeZone`. `vite build` with `nitro()` registers each Definition as a Nitro task in `scheduledTasks`. Nitro fires it with Cloudflare Cron Triggers, Vercel Cron Jobs, or an in-process `croner` timer on Node. ViteHub adds a Netlify Scheduled Function and a Deno Deploy `Deno.cron()` plugin, because Nitro has no scheduler for those presets. Host selection, local execution, deployment proof, limits, and billing still come from the selected host. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before deploying.

Applications that use the framework distribution register Schedule through `vitehub({ preset, schedule: true })` and import the definition helper from `vite-hub/schedule`. 
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

The module must be an absolute file path or `file:` URL, and the export must be `default`. The module follows the file rules: `export default defineSchedule({ cron: "...", handler })` with literal options, because the build reads it from source. Contributed Schedules get the same Nitro task, `vitehub schedule run` support, inspection, and Console records as `server/schedules/` files. A name used by both a file and a contribution fails the build with `SCHEDULE_B0006`.

## Run Static Schedules on Node

A self-hosted Node server or Docker container runs the built Nitro server. Nitro starts one `croner` timer per cron in that process and runs the Schedule task when it is due. Run one replica, or each replica runs every Schedule. A restart does not run the minutes that the process missed.

## Understand time zones

Static Schedule Definitions and their host crons always use UTC.

## Choose storage

Schedule Runs record manual runs and the runs that Nitro scheduled tasks start. The memory store is the default for direct calls. It is process-local and loses run history on restart. Use `createKVScheduleRunStore({ kvStore })` when runs must survive a restart. The factory requires an explicit `ScheduleKVStorage`. Static schedules, memory stores, and custom storage do not require `@vite-hub/kv`.

To use ViteHub KV, install `@vite-hub/kv` and import the adapter explicitly:

```ts
import { createKVScheduleRunStore } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Applications using the framework can import it from `vite-hub/schedule/runtime/kv`.

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

