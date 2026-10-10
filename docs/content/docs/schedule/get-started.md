---
title: Run a daily report once with Schedule
description: Declare a UTC schedule and execute one occurrence with the direct runtime API.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Run one occurrence of a daily report and check that it finishes with `succeeded`. You will declare its UTC cron expression, then trigger a fixed occurrence from a script. This lets you test the handler without waiting until tomorrow.

You need Node.js 24.15 or newer and pnpm. Start in an empty directory. The script uses an in-memory run store and needs no Vite server or provider account. It runs once; [host configuration](/docs/schedule/hosts) supplies the recurring trigger in a deployed app.

::tutorial-step{title="Install"}
## Install

Initialize an ESM package so Node can load the TypeScript modules below:

```bash [commands/install]
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/schedule
```

::

::tutorial-step{title="Declare the schedule"}
## Declare the schedule

`0 8 * * *` means every day at 08:00 UTC. `manual: true` allows a manual occurrence. The handler logs the occurrence time rather than the current wall-clock time.

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  handler({ scheduledAt }) {
    console.log(`Daily report scheduled for ${scheduledAt.toISOString()}`)
  },
})
```

Create the `server/schedules` directory and save this as `daily-report.ts`. After the manual run works, replace the log with your report code.

::

::tutorial-step{title="Execute one occurrence"}
## Execute one occurrence

Create a script that imports the Definition and executes a fixed occurrence:

The fixed timestamp makes the result repeatable. Importing and executing this Definition does not create a recurring timer.

```ts [run.ts]
import { executeStaticSchedule } from '@vite-hub/schedule/runtime'
import dailyReport from './server/schedules/daily-report.ts'

const run = await executeStaticSchedule({
  cron: dailyReport.cron,
  definition: dailyReport,
  name: 'daily-report',
  scheduledAt: new Date('2026-08-27T08:00:00.000Z'),
})

console.log(run.status)
```

Node.js can run this TypeScript script directly:

```bash [commands/run]
node run.ts
```

The process prints:

```txt [output/daily-report.txt]
Daily report scheduled for 2026-08-27T08:00:00.000Z
succeeded
```

The handler ran for the exact timestamp you supplied. To run it every day, add the Schedule integration to your app and configure a hosted scheduler or a long-lived Node process. [Hosts](/docs/schedule/hosts) explains those options.

::

## Choose the next path

- Keep this Static Schedule when the cron and target are part of the release.
- Use a [Runtime Schedule](/docs/schedule/server-api#create-recurring-runtime-schedules) when users or Agents manage persisted records.
- Read [Hosts](/docs/schedule/hosts) for provider wake output, long-running Node processes, and time zones.
