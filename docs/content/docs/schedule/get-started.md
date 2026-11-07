---
title: Run a daily report with Schedule
description: Write a job that runs every day at 08:00 UTC, then run it once to test it now.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You write a job that runs every day at 08:00 UTC. Then you run it once from a script, so you can test it now and not wait until tomorrow.

You need:

- Node.js 22.18 or newer
- pnpm
- an empty folder

You do not need a Vite app or a cloud account.

::tutorial-step{title="Install"}
## Install

Create a `package.json` file with this content. `"type": "module"` tells Node.js that your files use `import` and `export`.

```json [package.json]
{
  "type": "module"
}
```

Then install Schedule:

```bash [commands/install]
pnpm add @vite-hub/schedule
```

::

::tutorial-step{title="Write the job"}
## Write the job

Create `server/schedules/daily-report.ts`:

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

- `cron` sets when the job runs. `0 8 * * *` means minute 0 of hour 8, every day. The time is in UTC. To use your own time zone, see [Configure](/docs/schedule/configure#run-a-static-schedule-in-a-time-zone).
- `manual: true` lets you run the job yourself, at a time that is not in `cron`.
- `handler` is the job. `scheduledAt` is the time that the run was planned for. It is not the current time.

Later, replace the `console.log` with your report code.

::

::tutorial-step{title="Run it once"}
## Run it once

Create `run.ts` next to `package.json`. It runs the job one time, as if the clock showed 08:00 UTC on 27 August 2026:

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

A fixed date gives the same output each time. This script does not start a timer, so the job does not run again tomorrow.

Run the script. Node.js 22.18 and newer run TypeScript files directly:

```bash [commands/run]
node run.ts
```

You see:

```txt [output/daily-report.txt]
Daily report scheduled for 2026-08-27T08:00:00.000Z
succeeded
```

The first line comes from your job. `succeeded` means that the job finished without an error.

::

## Next steps

- [Configure](/docs/schedule/configure): add Schedule to a Vite app, so the app finds every file in `server/schedules/`.
- [Hosts](/docs/schedule/hosts): run the job every day on Cloudflare, Vercel, Netlify, or your own Node.js server.
