---
title: Run a daily report with Schedule
description: Write a schedule that runs every day at 08:00 UTC, then start it by hand to see it work now.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Schedule is server code that runs at set times, like an alarm clock for your app. You write the time and the code in one file. ViteHub tells your host when to run it.

In this tutorial, you write a daily report that runs every day at 08:00 UTC. Then you start it by hand from the CLI, so you see it work now and not tomorrow morning.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation). Everything runs locally on your computer, with no account or API key needed.

::tutorial-step{title="Turn on Schedule"}
## Turn on Schedule

Install the Schedule and KV packages:

```bash pm [commands/install]
pnpm add @vite-hub/schedule @vite-hub/kv
```

Add `kv: true` to your ViteHub options, keeping your other app options. Without KV, the server keeps the runs in memory, and they are gone after a restart. With KV, the runs that you read in the last step stay.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    kv: true,
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
    }),
  ],
})
```
::::
:::

The schedule file that you create next turns Schedule on. You can also set `schedule: true` for the same defaults. Node has no host cron, so ViteHub checks for due schedules once a minute in the server process.

::

::tutorial-step{title="Write the schedule"}
## Write the schedule

Create `server/schedules/daily-report.ts`. The file name is the schedule name: `daily-report`.

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
- `manual: true` lets you start the schedule by hand. Without it, only the cron clock can start a run.
- `scheduledAt` is the time that the run is for, not the time that it started. A run that starts late still gets `08:00`. Use it to know which day the report is for.

In a real app, put your report logic in `handler`. For now, it logs a line to the console.

::

::tutorial-step{title="Run it now"}
## Run it now

Start the dev server:

```bash [commands/dev]
pnpm dev
```

Open a second terminal in the same folder and start the schedule by hand:

```bash [commands/run]
pnpm vitehub schedule run daily-report
```

The command prints the run result:

```txt [output/run.txt]
succeeded daily-report in 7 ms
Run srun_manual_daily-report_2026-11-07T12:33:04.174Z_manual_mw6dwazy_ug9q6smg
Scheduled at 2026-11-07T12:33:04.174Z
```

The dev server terminal shows the log line from your handler:

```txt [output/dev-server.txt]
Daily report for 2026-11-07T12:33:04.174Z
```

To test a specific date, pass `--at`. The handler receives that timestamp as `scheduledAt`:

```bash [commands/run-at]
pnpm vitehub schedule run daily-report --at 2026-01-31T08:00:00Z
```

::

::tutorial-step{title="See the runs"}
## See the runs

ViteHub saves each manual run and Process Runtime run with its status and time. List the runs for `daily-report`, newest first:

```bash [commands/runs]
pnpm vitehub schedule runs list daily-report
```

```txt [output/runs.txt]
RUN                                                                         STATUS     SCHEDULED AT              ATTEMPTS  ERROR
srun_manual_daily-report_2026-11-07T12:33:04.174Z_manual_mw6dwazy_ug9q6smg  succeeded  2026-11-07T12:33:04.174Z  1         -
srun_manual_daily-report_2026-01-31T08:00:00.000Z_manual_mw6dwbtr_3xkimura  succeeded  2026-01-31T08:00:00.000Z  1         -
```

A saved run that throws shows `failed` and its error. Provider cron executions do not create saved runs.

You can also see the same runs and start the schedule from the [Console](/docs/console).

::

## What happens when you deploy

Keep the schedule file when you change hosts. You do not need to change the `schedule` option:

- **Node or Docker**: the server process runs the schedule at 08:00 UTC. With multiple server processes, add a Postgres or remote libSQL Database so one process runs each occurrence. Without a Database, keep one process running. A stopped process runs nothing.
- **Cloudflare, Vercel, or Netlify**: the build writes the host's cron settings, and the host starts the schedule.

For example, on Vercel:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [vercel/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel' },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vercel/vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel' }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vercel/vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel' })],
})
```
:::
::

On the `deno` host, the same file registers each Schedule with `Deno.cron`. [Hosts](/docs/schedule/hosts) shows the output for each host.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/schedule/configure"}
Set a time zone, change the cron on one host, and see every option.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/schedule/hosts"}
See what the build writes for Cloudflare, Vercel, Netlify, Deno, and Node.
:::
::
