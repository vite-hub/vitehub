---
title: Run a daily report with Schedule
description: Write a schedule that runs every day at 08:00 UTC, then start it by hand to see it work now.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Schedule is server code that runs at set times, like an alarm clock for your app. You write the time and the code in one file. ViteHub tells your host when to run it.

In this tutorial, you write a daily report that runs every day at 08:00 UTC. Then you start it by hand, so you see it work now and not tomorrow morning.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). You need no account and no API key. Everything runs on your computer.

::tutorial-step{title="Turn on Schedule"}
## Turn on Schedule

Schedule and KV are separate packages. Add them to your app:

```bash pm [commands/install]
pnpm add @vite-hub/schedule @vite-hub/kv
```

Then add `kv` and `schedule` to the ViteHub options. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    kv: true,
    schedule: { runtime: { driver: 'process' } },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      kv: true,
      schedule: { runtime: { driver: 'process' } },
    }), nitro(),
  ],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      kv: true,
      schedule: { runtime: { driver: 'process' } },
    }),
  ],
})
```
::::
:::

- `schedule` turns on Schedule. A Node server has no cron of its own, so the `process` runtime checks for due schedules once a minute while the server runs.
- `kv` gives Schedule a place to save each run. You read those runs in the last step.

::

::tutorial-step{title="Write the schedule"}
## Write the schedule

Create `server/schedules/daily-report.ts`. The file name is the name of the schedule: `daily-report`.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  handler({ scheduledAt }) {
    console.log(`Daily report for ${scheduledAt.toISOString()}`)
  },
})
```

- `cron: '0 8 * * *'` means "at minute 0 of hour 8, every day". The time is in UTC. Set `timeZone` to use another time zone.
- `manual: true` lets you start the schedule by hand. Without it, only the clock can start it.
- `scheduledAt` is the time that the run is for, not the time that it started. A run that starts late still gets `08:00`. Use it to know which day the report is for.

Later, put your report code in `handler`. For now, it only writes a line to the log.

::

::tutorial-step{title="Run it now"}
## Run it now

Start the dev server:

```bash [commands/dev]
pnpm dev
```

Open a second terminal in the same folder, and start the schedule by hand:

```bash [commands/run]
pnpm vitehub schedule run daily-report
```

The command prints the result of the run:

```txt [output/run.txt]
succeeded daily-report in 7 ms
Run srun_manual_daily-report_2026-11-07T12:33:04.174Z_manual_mw6dwazy_ug9q6smg
Scheduled at 2026-11-07T12:33:04.174Z
```

The dev server terminal shows the line from your handler:

```txt [output/dev-server.txt]
Daily report for 2026-11-07T12:33:04.174Z
```

To test a given day, add `--at`. The handler gets that time as `scheduledAt`:

```bash [commands/run-at]
pnpm vitehub schedule run daily-report --at 2026-01-31T08:00:00Z
```

::

::tutorial-step{title="See the runs"}
## See the runs

ViteHub saves each manual run and Process Runtime run, with its status and its time. List the runs of `daily-report`, newest first:

```bash [commands/runs]
pnpm vitehub schedule runs daily-report
```

```txt [output/runs.txt]
RUN                                                                         STATUS     SCHEDULED AT              ATTEMPTS  ERROR
srun_manual_daily-report_2026-11-07T12:33:04.174Z_manual_mw6dwazy_ug9q6smg  succeeded  2026-11-07T12:33:04.174Z  1         -
srun_manual_daily-report_2026-01-31T08:00:00.000Z_manual_mw6dwbtr_3xkimura  succeeded  2026-01-31T08:00:00.000Z  1         -
```

A saved run that throws shows `failed` and its error. Provider cron executions do not create saved runs.

To see the same runs in a page, with a button to run the schedule, open the app in the [Console](/docs/development/console).

::

## What happens when you deploy

You keep the schedule file. You change the `schedule` option for the host:

- **Node or Docker**: keep `runtime: { driver: 'process' }`. The server process starts the schedule at 08:00 UTC. With more than one server process, add a Postgres or remote libSQL Database, and one process runs each occurrence. Without a Database, keep one process running. A stopped process runs nothing.
- **Cloudflare, Vercel, or Netlify**: set the host of the host and `schedule: true`. The build then writes the cron settings of the host, and the host starts the schedule. Do not keep `runtime`. On Cloudflare and Netlify, keeping `runtime` makes the server process own the schedules and suppresses provider cron output. Vercel defaults to standalone cron output even when `runtime` is set.

For example, on Vercel:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [vercel/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel', schedule: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vercel/vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', schedule: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vercel/vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', schedule: true })],
})
```
:::
::

The `deno` host does not support Schedule. [Hosts](/docs/schedule/hosts) shows the output for each host.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/schedule/configure"}
Set a time zone, change the cron on one host, and see every option.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/schedule/hosts"}
See what the build writes for Cloudflare, Vercel, Netlify, Deno, and Node.
:::
::
