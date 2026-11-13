# @vite-hub/schedule

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fschedule&icon=npm)](https://npmx.dev/package/@vite-hub/schedule)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fschedule&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/schedule)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/schedule` discovers recurring work, generates cron output for supported hosts, and can run Static Schedule Definitions in one long-lived process.

## Choose the package

Install `vite-hub` and `@vite-hub/schedule` for an application. `vite-hub` exposes application imports under `vite-hub/schedule` and loads Schedule from the app.

```sh
pnpm add vite-hub @vite-hub/schedule
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

Both packages require Node.js 22.18 or newer.

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

```ts fragment
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

Static Schedule Definitions use five-field cron expressions. The cron uses UTC unless the definition sets `timeZone` to an IANA name, such as `Europe/Madrid`. `timeZone` works with the Process Runtime and with every host's cron output.

The integration can generate host-specific output for Cloudflare Cron Triggers, Vercel Cron Jobs, Netlify Scheduled Functions, standalone `Deno.cron`, Nitro's Cloudflare schedule hook, and Netlify Scheduled Functions that run in Nitro's server bundle. A build writes only the output of its host: Nitro's resolved preset, or else `nitro.preset`, `NITRO_PRESET`, `SERVER_PRESET`, or `VITEHUB_HOSTING`. It writes the output of every host only when no host is known. Host selection, local execution, deployment proof, limits, and billing still come from the selected host. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before deploying.

Applications that use the framework distribution register Schedule through `vitehub({ preset, schedule: true })` and import the definition helper from `vite-hub/schedule`. The Deno framework preset currently rejects Schedule because standalone Deno cron output sits outside its generated Nitro entrypoint. Use the direct Schedule integration for that output.

Nuxt projects enable Schedule with `vite-hub/nuxt` and `vitehub: { schedule: true }`. The module installs the Vite integration and merges Schedule output into Nitro config.

## Start a Schedule from code

Leave out `cron` when your users pick the time, such as a reminder. Code then starts the Definition with `startSchedule()`, once at `at` or on a `cron` in a `timeZone`, and the handler gets `payload`.

```ts
// server/schedules/reminder.ts
import { defineSchedule } from "@vite-hub/schedule";

export default defineSchedule({
  handler({ payload }) {
    console.log("Reminder", payload);
  },
});
```

```ts
import { cancelSchedule, listSchedules, startSchedule } from "@vite-hub/schedule";

const [error, reminder] = await startSchedule("reminder", { at: "2026-11-08T09:00:00Z", payload: { text: "Call Ana" } });
const [, standUp] = await startSchedule("reminder", { cron: "0 9 * * 1-5", timeZone: "Europe/Madrid", payload: { text: "Stand-up" } });
const [, started] = await listSchedules({ name: "reminder" });
await cancelSchedule(standUp!.id);
```

The functions return `[error, data]`. The Schedules are stored in KV, so they survive restarts and deploys. When a Definition has no `cron`, the build adds the Schedule `vitehub/started-schedules` with the cron `* * * * *`: Cloudflare wakes it with a Cron Trigger, and the Process Runtime wakes it on Node. Each wake runs the started Schedules that are due. Started Schedules need KV, and on Node the Process Runtime. `vitehub schedule list`, `start`, and `cancel` and the Console Schedules page show and change them. Read the [server API](https://vitehub.dev/docs/schedule/server-api#start-a-schedule-from-code) for the delivery rules.

## Understand time zones

The value of `timeZone` must be an IANA name. Abbreviations such as `PST` and numeric offsets such as `+01:00` are rejected. The Process Runtime accepts any expression, such as a shared constant. Host cron output reads `timeZone` from the source file at build time, so write it as a string literal there. A dynamic value fails the build with `SCHEDULE_R0003`.

Cloudflare, Vercel, Netlify, and Deno read cron in UTC only. For a Schedule with a `timeZone`, the build writes a UTC cron that covers every offset of the time zone in the next two years, and the runtime checks the local time on each wake. `0 8 * * *` in `Europe/Madrid` becomes `0 6,7 * * *`: the host wakes the Schedule twice a day, and the Schedule runs at the wake that is 08:00 in Madrid. When a local time moves to another UTC day, the UTC cron wakes every day, or on the shifted weekdays, and the runtime checks the local date. A `cron` override in the build config replaces both the cron and the time zone: the host runs the override in UTC. Rebuild when a time zone changes its rules.

On daylight saving time changes, every host and the Process Runtime behave the same:

- A local time that the clock skips runs once, shifted by the length of the gap, as RFC 5545 and `Temporal` read it. `30 2 * * *` in `Europe/Madrid` runs at 03:30 on the spring-forward day.
- A local time that occurs twice runs once, at its first occurrence, when the cron sets a fixed minute and hour. A cron with `*` in the minute or hour field runs on elapsed time, so it also runs in the repeated hour.

## Run a Schedule once per occurrence

Each run gets `idempotencyKey`, `schedule:<name>:<scheduledAt ISO>`. Cloudflare supplies the scheduled timestamp, and the Process Runtime records each occurrence. Repeated deliveries of those occurrences keep the same key. Pass the key to Email, a Channel `send()`, or a Queue on Vercel or the local driver to dedupe work with the same key:

```ts fragment
export default defineSchedule({
  cron: "0 7 * * *",
  timeZone: "Europe/Stockholm",
  async handler({ idempotencyKey }) {
    await email.send({ from, to, subject: "Today's lesson", text, idempotencyKey });
  },
});
```

The Process Runtime also stores one run per occurrence, so it does not run a repeated wake again. Host cron output does not store runs.

Vercel, Netlify, and Deno do not supply a scheduled timestamp to these entries. They estimate `scheduledAt` as the latest host UTC cron match within the previous day, or the current minute when none matches. A late delivery or retry after another host cron match can get a different key. Time-zone filtering uses that estimate too: a summer Madrid 06:00 wake delivered after the extra 07:00 wake can be skipped. These hosts cannot guarantee occurrence identity or dedupe across that boundary. Use an application business key for side effects that must dedupe across delays and retries.

## Run schedules in the server process

The generated Process Runtime runs each Static Schedule Definition on its cron inside the Node.js process. It records Schedule Runs in the default KV store configured by `hubKV()`. Use it on long-lived servers, one or more:

```ts
import { hubKV } from "@vite-hub/kv/vite";
import { hubSchedule } from "@vite-hub/schedule/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    hubKV(),
    hubSchedule({
      runtime: {
        driver: "process",
        prefix: "my-app:schedule",
      },
    }),
  ],
});
```

Its defaults are prefix `vitehub:schedule`, scan interval `60_000` milliseconds, concurrency `1`, catch-up `catchUpMs` of one hour, and `leaseTtlMs` of one minute. The interval cannot exceed one minute. `concurrency` limits runs only inside that process. A queued occurrence can start while its scheduled minute is within `catchUpMs` of the current minute; older queued work is dropped. With `catchUpMs: 0`, it can start only in its scheduled minute. After a restart, the runtime runs the due minutes that no process checked, within `catchUpMs`, for each Schedule that already has a run. Run ids are deterministic, so a minute that already ran does not run again. Request-scoped and serverless hosts must not use the Process Runtime because the process may stop between requests.

### Run on more than one server

Every server checks every Schedule. Before a server runs an occurrence, it takes a lease on the key `<prefix>/schedule/<run id>`, such as `vitehub:schedule/schedule/srun_static_daily_2026-11-09T08:00:00.000Z`. The prefix is `runtime.prefix`, which defaults to `vitehub:schedule`. Use a different prefix for each app that shares a Database, and the same prefix on every server of one app. One server gets the lease and runs the occurrence while it holds that lease. The others skip it and try again at their next scan. Started Schedules use the same lease for each occurrence. Manual runs have their own run id, so the server that gets the request runs them once.

- The server that holds the lease renews it every third of `leaseTtlMs` while the run works. When the run ends, it writes a done marker (`<prefix>/schedule/<run id>/done`) and frees the lease. The marker lasts for `catchUpMs` plus `leaseTtlMs` plus two minutes, so a server that starts later does not run the occurrence again. If the marker write fails, the server reports the error and tries to extend its claim for the same time, without releasing it. If that also fails, another server can run the occurrence after the claim expires.
- If the server loses the Database, or its event loop pauses, for longer than `leaseTtlMs`, its lease can expire while its handler still runs. Another server can run the same occurrence at the same time. The runtime reports renewal failures, but cannot stop the handler or undo its effects. Choose a TTL longer than expected pauses and make external effects idempotent.
- If the lease store fails before a run starts, the server reports the error and retries at its next scan while the occurrence is inside `catchUpMs`.
- A failed run is final, as on one server. It is not retried.
- When a server stops during a run, for example after a crash, its lease ends after `leaseTtlMs`. Then another server runs the occurrence, unless it has a done marker. With shared run history, the run gets a new attempt, and the stopped attempt is marked as failed. This also works when every server restarts: at start, a server reads the runs inside `catchUpMs` that are still pending or running, and tries them again.

The generated runtime keeps the leases in the `vitehub_leases` table of the Default Database, through `createSqlLeaseStore()` from `@vite-hub/runtime`. That works on Postgres and remote libSQL. A local libSQL file is safe for one server process only, because `@libsql/client` can lose writes when several processes write to one file. The server prints a warning at start in that case. Without a Database, the leases stay in memory and the build prints a warning: each server then runs every occurrence, so run one server only. The run history stays in KV. Use a KV store that all servers share, such as Upstash, so catch-up and the Console see the runs of every server.

With the Process Runtime, the default `providerOutput: "auto"` emits no host Provider Output, so the process owns Static Schedule wakes. Set `providerOutput: "standalone"` or `"nitro"` to move Static Schedule wakes to that Provider Output. `providerOutput: false` records the same wake ownership as `"auto"` in this configuration.

A custom long-running host can call `installProcessScheduleRuntime({ registry, scheduleRunStore, leases, prefix })` from `@vite-hub/schedule/runtime/process`. Pass the same shared `LeaseStore` and prefix to every process of one app. `prefix` defaults to `vitehub:schedule`; use the same prefix for the app's Schedule stores. Without `leases`, it uses `createMemoryLeaseStore()`, which is for one process only. Call and await `controller.close()` during shutdown. It waits for active runs and their `waitUntil()` work, then stops the timer. It does not delete Schedule Definitions or run history. The generated Nitro Process Runtime registers the same close operation with ViteHub shutdown. See [graceful shutdown](../runtime/README.md).

## Choose storage

Schedule Runs record manual runs and Process Runtime runs. Provider cron output runs the handler without a run record.

The memory store is the default for direct calls. It is process-local and loses Schedule Run history on restart. Use `createKVScheduleRunStore({ kvStore })` when runs must survive a restart. The factory requires an explicit `ScheduleKVStorage`. To use ViteHub KV, install `@vite-hub/kv` and import the adapter explicitly:

```ts
import { createKVScheduleRunStore } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

Generated Process Runtime wiring selects this adapter automatically. Applications using the framework can import it from `vite-hub/schedule/runtime/kv`. Use `setScheduleRunStore(store)` to install a custom `ScheduleRunStore`.

Custom stores must apply the `listRuns({ scheduleId, idPrefix, limit })` filters before the limit. The Process Runtime requests `idPrefix: "srun_static_"` with `limit: 1` to read its newest cron run without loading manual run history.

## Run and inspect schedules

`hubSchedule()` contributes the `schedule.runs`, `schedule.attempts`, `schedule.run`, `schedule.list`, `schedule.start`, and `schedule.cancel` operations. They are the `vitehub schedule runs <id> [--limit <n>]`, `attempts <runId>`, `run <name>`, `list [name]`, `start <name>`, and `cancel <id>` commands, and the Console runs them too. Each command accepts `--json` and `--url`. Without `--url` the command calls the dev server of the project, whose Nitro runtime owns the same stores and registry as the running app.

Set `manual: true` on a Static Schedule Definition to allow an on-demand run, then invoke it with `vitehub schedule run <name>`. The name is the discovered schedule file name. Add `--url <app-url>` to run it on a deployment that enables `console.invoke`. The command signs the call with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, so a CI job needs only that secret. `vitehub secret console-key ci` prints a new key pair. Server code can call `runSchedule(name, { registry })` from `@vite-hub/schedule/runtime`. Each manual run gets a new `srun_manual_` id.

Add `--at <ISO date-time>` to run it as if the cron fired at that time, for example `vitehub schedule run close-month --at 2026-01-31T23:59:00Z`. The handler gets the time as `scheduledAt`, and the run records it, so `vitehub schedule runs` lists it under that time. `runSchedule()` takes the same value as `scheduledAt`. The value needs `Z` or an offset. A value without a time zone, a date only, or a day that does not exist fails with `SCHEDULE_INVALID_SCHEDULED_AT` before the handler runs. The time is not checked against the cron. Manual runs do not advance the Process Runtime's catch-up cursor, even when their scheduled time is in the future.

Discovery reads `manual` as a literal boolean from directly exported Definitions. Use identifier keys or quoted keys without escape sequences. Spreads, computed keys, escaped keys, and metadata getters or methods fail with the source file and line.

The Console Schedules section lists Schedule Definitions with their cron, time zone, and manual state. It reads them at build time. When the server runs the Process Runtime, the cron and time zone come from the loaded Definitions on each request, so they are the values that the runtime uses. `vitehub inspect definitions` reads them from the source file and shows `Not a static string` for a value that it cannot read there. Use `vitehub schedule runs <name>` to list the runs that the runtime recorded. The CLI and the Console redact credentials in error messages.

## Import runtime helpers

The main `@vite-hub/schedule` entry exports `defineSchedule`, `startSchedule`, `getSchedule`, `listSchedules`, `cancelSchedule`, and public types. Import execution, storage, and runtime state helpers from `@vite-hub/schedule/runtime`. Import `installProcessScheduleRuntime` from `@vite-hub/schedule/runtime/process`. Import `discoverScheduleDefinitions` from `@vite-hub/schedule/vite` when writing a build integration. Applications use `vite-hub/schedule` and `vite-hub/schedule/runtime`.

Static Schedule execution logs each failed handler as `[vitehub:schedule] Schedule "<name>" failed` with the message, stack, status, and cause chain. The other schedules on the same cron still finish. The run rejects with the error, or with an `AggregateError` when several failed.

`executeSchedule()` accepts `captureHandlerFailure: true` to return the persisted failed run after a handler error. Pre-execution guards still throw.

## Documentation and support

- Read the [Schedule guide](https://vitehub.dev/docs/schedule) for every public import, Runtime Helper, store, and Vite option.
- Check [Provider Output](https://vitehub.dev/docs/reference/provider-output) for generated files and deployment inspection.
- Check [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for current proof and host qualifications.
- Report package problems in the [ViteHub issue tracker](https://github.com/vite-hub/vitehub/issues).

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).
