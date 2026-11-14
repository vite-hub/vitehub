---
title: Schedule configuration
description: Configure Schedule in Vite, run schedules in a Node process, define schedules, and store run history.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    kv: true,
    schedule: {
      runtime: {
        driver: 'process',
        prefix: 'my-app:schedule',
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      kv: true,
      schedule: {
        runtime: {
          driver: 'process',
          prefix: 'my-app:schedule',
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      kv: true,
      schedule: {
        runtime: {
          driver: 'process',
          prefix: 'my-app:schedule',
        },
      },
    }),
  ],
})
```
:::
::

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cron` | `Record<string, string>` | Each Schedule's own cron | Cron per Schedule name for this build's host. See [Run a Schedule on another cron on one host](#run-a-schedule-on-another-cron-on-one-host). |
| `providerOutput` | `ScheduleOptions['providerOutput']` | `auto` | Controls generated provider cron output for the build's host. Values: `auto`, `standalone`, `nitro`, `false`. |
| `projectRoot` | `string` | ViteHub project root | Resolves discovered schedule files and generated registry output from a custom project root. |
| `runtime` | `ScheduleProcessRuntimeOptions` | No runtime driver | Explicitly installs the generated Nitro Process Runtime. Accepts `driver: 'process'`, plus optional `prefix` (default `vitehub:schedule`), `intervalMs` (default `60_000`), `concurrency` (default `1`), `catchUpMs` (default one hour), and `leaseTtlMs` (default `60_000`). |

Use `createScheduleNitroConfig()` when your Nitro integration merges config and needs Schedule's provider output in Nitro form.

The Process Runtime loads the discovered registry and runs each Static Schedule Definition on its cron inside the Node.js process.

- It records Schedule Runs in the default KV store (the `kv` option) under the prefix, reports errors through Nitro, and stops on Nitro shutdown.
- By default it checks once per minute, with one run at a time. `intervalMs` cannot be more than one minute.
- Each check covers the minutes since the last one that are still inside `catchUpMs`, plus the current minute.
- After a restart, it runs due minutes that no process checked, such as during a deploy, for each schedule that already has a run. It looks back at most one hour (`installProcessScheduleRuntime({ catchUpMs })`, `0` turns it off).
- Run ids are fixed per minute, so a minute never runs twice.
- `runtime` and `providerOutput` are separate. Setting one does not set the other.

::warning
Do not use this driver on request-scoped or serverless hosts that may stop between requests. It scans inside the Node.js process and does not create cron, systemd, or another operating-system schedule.
::

### Run on more than one server

Every server checks every Schedule. While the holder keeps its lease, one server runs each occurrence. Before it runs an occurrence, a server takes a lease on `<prefix>/schedule/<run id>` in the `vitehub_leases` table of the Default Database. The prefix is `runtime.prefix`, which defaults to `vitehub:schedule`. Use a different prefix for each app that shares a Database, and the same prefix on every server of one app. The other servers skip the occurrence and try again at their next scan. This works on Postgres and remote libSQL, such as Turso. A local libSQL file is safe for one server process only: `@libsql/client` can lose writes when several processes write to one file, so the server prints a warning at start.

| Case | What happens |
| --- | --- |
| The run works for a long time | The server renews its lease every third of `leaseTtlMs`. |
| The run ends | The server writes a done marker, `<prefix>/schedule/<run id>/done`, and frees the lease. The marker lasts for `catchUpMs` plus `leaseTtlMs` plus two minutes, so catch-up on another server does not run the occurrence again. |
| The done marker write fails | The server reports the error and tries to extend its claim for the same time as the marker, without releasing it. If that also fails, another server can run the occurrence after the claim expires. |
| The server loses the Database, or its event loop pauses, for longer than `leaseTtlMs` | Its lease can expire while its handler still runs. Another server can then run the same occurrence at the same time. The runtime reports renewal failures, but cannot stop the handler or undo its effects. Choose a TTL longer than expected pauses and make external effects idempotent. |
| The lease store fails before the run starts | The server reports the error and retries at its next scan, while the occurrence is inside `catchUpMs`. |
| The run store fails before the handler starts | No done marker is written. The occurrence can retry after the store recovers. A one-time started Schedule stays until its handler can start. |
| A Static occurrence waits for a free worker | It can start while its scheduled minute is inside `catchUpMs` of the current minute. Older queued occurrences are dropped. With `catchUpMs: 0`, queued work can start only in its scheduled minute. |
| The handler fails | The run is final, as on one server. No server retries it. |
| The server stops during the run | Its lease ends after `leaseTtlMs`. Then another server runs the occurrence, unless a done marker exists. The run gets a new attempt, and the stopped attempt is marked as failed. |
| Every server restarts after a crash | At start, each server reads the Static Schedule runs inside `catchUpMs` that are still pending or running. It tries them like a held occurrence: one server runs each of them when the lease of the stopped server ends. |
| A started Schedule is due | Each occurrence takes the same lease, so one server runs it. |
| A manual run | The server that gets the request runs it once. Each manual run has its own run id. |

Without a Database, the leases stay in the memory of each server, and the build prints a warning. Then each server runs every occurrence, so run one server only. The Schedule Runs stay in KV. Use a KV store that all servers share, such as Upstash, so catch-up, `vitehub schedule runs`, and the Console see the runs of every server.

Inspect the leases with SQL, for example `select "key", owner, expires_at from vitehub_leases where "key" like 'vitehub:schedule/schedule/%'`. Replace `vitehub:schedule` with the app's prefix. `owner` is the host name and process ID of the server.

## Run a Schedule on another cron on one host

Some hosts limit cron. Vercel Hobby runs cron jobs at most once a day. Set `cron` in that host's build config to give a schedule another cron there only:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    // server/schedules/cleanup.ts declares cron: '0 * * * *'
    schedule: { cron: { cleanup: '0 0 * * *' } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      // server/schedules/cleanup.ts declares cron: '0 * * * *'
      schedule: { cron: { cleanup: '0 0 * * *' } },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      // server/schedules/cleanup.ts declares cron: '0 * * * *'
      schedule: { cron: { cleanup: '0 0 * * *' } },
    }),
  ],
})
```
:::
::

The keys are schedule names. The new cron replaces the declared one in the host output: Vercel and Netlify cron jobs, Cloudflare cron triggers, and `Deno.cron`. `vitehub inspect definitions` shows it as `Cron`, next to `Declared cron`.

The build fails with `SCHEDULE_B0008` when a name matches no schedule. It also fails when the Process Runtime runs the schedules, because it always uses the declared cron. With `providerOutput: 'nitro'` or `'standalone'`, the host runs them, so `cron` applies.

## Define a static schedule

A Static Schedule Definition is a file whose cron the build reads, so it can write host cron entries.

```ts [server/schedules/daily-report.ts] fragment
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  async handler(context) {
    await sendDailyReport(context.scheduledAt)
  },
})
```

Cron uses UTC unless you set `timeZone`. The file name is the schedule name.

## Schedule Definition options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `cron` | `string` | Yes | Five-field cron expression, evaluated in `timeZone`. |
| `handler` | `ScheduleHandler` | Yes | Function called with Schedule Run Context. |
| `manual` | `boolean` | No | Allows `vitehub schedule run` and Console invocation to run this definition outside its cron. |
| `timeZone` | `string` | No | IANA time zone of `cron`, such as `Europe/Madrid`. Defaults to `UTC`. Works on every host. |

Set `manual: true` to allow runs on demand:

```ts [server/schedules/daily-report.ts] fragment
export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  async handler() {
    await sendDailyReport()
  },
})
```

## Run a static schedule in a time zone

Set `timeZone` when the cron must follow a local clock:

```ts [server/schedules/morning-brief.ts] fragment
export default defineSchedule({
  cron: '0 8 * * 1-5',
  timeZone: 'Europe/Madrid',
  async handler(context) {
    await sendMorningBrief(context.scheduledAt)
  },
})
```

This runs at 08:00 in Madrid: 06:00 UTC in summer and 07:00 UTC in winter. The value must be an IANA name. Abbreviations such as `PST` and numeric offsets are rejected.

Cloudflare, Vercel, Netlify, and Deno read cron in UTC only. The build gives the host a UTC cron that covers both offsets, `0 6,7 * * 1-5` here, and the Schedule runs only at the wake that is 08:00 in Madrid. On those hosts, write `timeZone` as a string literal, because the build reads it from the source file. The process driver (`runtime: { driver: 'process' }`) also accepts an expression, such as a shared constant. A `cron` override in the build config runs in UTC and replaces the time zone.

On daylight saving time changes, every host behaves the same. A local time that the clock skips runs once, shifted by the length of the gap: `30 2 * * *` in `Europe/Madrid` runs at 03:30 on the spring-forward day. A local time that occurs twice runs once, at its first occurrence, when the cron sets a fixed minute and hour. A cron with `*` in the minute or hour field runs on elapsed time, so it also runs in the repeated hour.

## Run the work once per occurrence

A host can deliver one cron wake twice. Each run gets `idempotencyKey`, `schedule:<name>:<scheduledAt ISO>`. Cloudflare supplies the scheduled timestamp, and the Process Runtime records each occurrence, so their repeated deliveries keep the same key. Pass it to Email, a Channel `send()`, or a Queue on Vercel or the local driver to dedupe work with the same key:

```ts [server/schedules/daily-lesson.ts] fragment
export default defineSchedule({
  cron: '0 7 * * *',
  timeZone: 'Europe/Stockholm',
  async handler({ idempotencyKey }) {
    await email.send({ from, to, subject: "Today's lesson", text, idempotencyKey })
  },
})
```

The process driver also stores one run per occurrence and does not run a repeated wake again.

Vercel, Netlify, and Deno do not supply a scheduled timestamp to these entries. They estimate `scheduledAt` as the latest host UTC cron match within the previous day, or the current minute when none matches. A late delivery or retry after another host cron match can get a different key. Time-zone filtering uses that estimate too: a summer Madrid 06:00 wake delivered after the extra 07:00 wake can be skipped. These hosts cannot guarantee occurrence identity or dedupe across that boundary. Use an application business key for side effects that must dedupe across delays and retries.

Start a manual run in one of these ways:

- On the dev server: `vitehub schedule run daily-report`. The name is the file name. It supports `--json`. Add `--at 2026-01-31T23:59:00Z` to run as if the cron fired then; the handler gets it as `scheduledAt`.
- On a deployment: `vitehub schedule run daily-report --url https://app.example.com`.
- From CI: `--url` [signs the call](/docs/console/signed-requests) with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` when it is set.
- From the Console.

Manual runs never move the Process Runtime's catch-up cursor, even with a future time.

Write `manual` as a literal `true` or `false` in the exported definition, with a plain or quoted key without escapes. The build does not evaluate constants, spreads, computed keys, or getters. Other forms fail with the file and line, so manual runs are never dropped in silence.

`ScheduleRunContext` has `id`, `scheduledAt`, `waitUntil`, and optional `attemptId`, `runId`, `scheduleId`, and `target` (the name of the schedule that runs).

Use `waitUntil(promise)` for important work that can outlive the handler. Direct and local runs wait for it before they record the result, and a rejection fails the run like a handler error. The Process Runtime keeps the work after the handler returns, reports rejections to `onError`, and waits for it on close.

## Contribute Schedules from a package

A package can add a schedule from its Vite plugin, so apps do not write `server/schedules/<name>.ts`. Add `vitehub.schedules` to the plugin. Each entry has a `name` and a `definition` with the module and export of a `defineSchedule()` result:

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
| `name` | `string` | Name for `vitehub schedule run <name>` and provider output. Letters, numbers, `.`, `_`, `-`, and `/`. |
| `definition.module` | `string` | Absolute file path or `file:` URL. Package names are not accepted (see below). |
| `definition.export` | `string` | Must be `default`, the export with `defineSchedule()`. Default `default`. |
| `reason` | `string` | Optional. Why the package adds it. Shown by `vitehub inspect definitions` and the Console. |

The build reads `cron` and `manual` from source without running the module. So the module follows the [file rules](#schedule-definition-options): a direct `export default defineSchedule({ ... })` with literal options. Bundled package output rarely keeps that form, so `definition.module` must be a file and `definition.export` must be `default`. Generate the module under `.vitehub/`, as above, or ship it as source and pass `fileURLToPath(new URL('./publish-schedule.ts', import.meta.url))`.

`vitehub.schedules` accepts an array or a factory, which can be async and gets `{ root, projectRoot, serverDirs }` (`root` is the Vite root). Schedule can read it before your `config` hook runs, so compute entries in the factory, not in your hooks. The factory runs once per discovery pass and must return the same result each time. ViteHub sorts entries by name.

A package schedule works like a `server/schedules/` file on every host, also with `providerOutput: 'auto'`. Its cron goes to Cloudflare Cron Triggers, Vercel cron config, Netlify Scheduled Functions, and the Nitro wake plugin. The Node Process Runtime runs it. `vitehub schedule run`, `vitehub inspect definitions`, and the Console list it, and inspection shows the plugin and its reason.

Build errors:

- `SCHEDULE_B0006`: the name is already used by a file or another plugin. The message names both.
- `SCHEDULE_B0007`: the entry is invalid, or the module does not exist.
- `SCHEDULE_B0005`: the module has no default export of `defineSchedule()`.

`collectScheduleContributions(plugins, context)` from `@vite-hub/schedule/vite` returns the checked list for other build steps.

## Storage

Manual runs and Process Runtime runs are recorded as Schedule Runs. Host cron runs the handler without a record.

| Store | Configure with | Nuance |
| --- | --- | --- |
| Memory Schedule Run Store | `createMemoryScheduleRunStore()` | Default. In-process history, for tests and local use only. |
| KV Schedule Run Store | `createKVScheduleRunStore({ kvStore, prefix? })` | Keeps runs and attempts in KV storage. |
| Custom Store | `setScheduleRunStore(store)` | Your own `ScheduleRunStore`. |

The KV factory needs a `ScheduleKVStorage`. For ViteHub KV, pass `scheduleKVStorage` from `vite-hub/schedule/runtime/kv`. Without `vite-hub`, import it from `@vite-hub/schedule/runtime/kv` and install `@vite-hub/kv`. Static schedules, memory stores, and custom stores do not need it.

```ts
import { createKVScheduleRunStore } from "vite-hub/schedule/runtime"
import { scheduleKVStorage } from "vite-hub/schedule/runtime/kv"

const scheduleRunStore = createKVScheduleRunStore({ kvStore: scheduleKVStorage })
```

The generated Process Runtime picks the adapter for you.
