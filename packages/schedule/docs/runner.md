---
title: Basic Self-Hosted Schedule Runner
description: Start Runtime Schedule execution from a Node, Nitro, or server entry point and understand current runner behavior.
navigation.title: Basic Runner
navigation.order: 4
icon: i-lucide-play-circle
frameworks: [vite, nitro]
---

The Basic Self-Hosted Schedule Runner scans the configured Runtime Schedule store from a long-lived process and executes due Runtime Schedules in-process.

Use it when the application owns a single server process or has a clearly elected single runner. It is not a distributed scheduler.

## Minimal Runtime Schedule example

First define a runtime-eligible target.

::fw{id="vite:dev vite:build"}
```ts [src/reports/daily.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log('run daily report', context.scheduleId, context.scheduledAt.toISOString())
}, {
  allowRuntimeSchedules: true,
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/schedules/reports/daily.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log('run daily report', context.scheduleId, context.scheduledAt.toISOString())
}, {
  allowRuntimeSchedules: true,
})
```
::

Then create a Runtime Schedule that targets that definition.

```ts
import { schedules } from '@vitehub/schedule'

await schedules.create({
  cron: '0 9 * * *',
  id: 'daily-report',
  target: 'reports/daily',
})
```

## Start from a Node entry point

Start the runner once from the process that should own dispatch.

```ts [server.ts]
import { startScheduleRunner } from '@vitehub/schedule'

const runner = startScheduleRunner({
  concurrency: 1,
  onError(error) {
    console.error('Schedule runner error', error)
  },
})

process.once('SIGINT', () => runner.stop())
process.once('SIGTERM', () => runner.stop())
```

`startScheduleRunner()` returns a controller with `running` and `stop()`.

## Start from a Nitro server plugin

For Nitro, start the runner from one server plugin and stop it during shutdown.

```ts [server/plugins/schedule-runner.ts]
import { startScheduleRunner } from '@vitehub/schedule'

export default defineNitroPlugin((nitroApp) => {
  const runner = startScheduleRunner({
    concurrency: 1,
    onError(error) {
      console.error('Schedule runner error', error)
    },
  })

  nitroApp.hooks.hookOnce('close', () => {
    runner.stop()
  })
})
```

Only install this plugin in the deployment process that should run schedules.

## Start from another server entry point

Any long-lived server entry can start the runner before listening for requests.

```ts [app-server.ts]
import { createServer } from 'node:http'
import { startScheduleRunner } from '@vitehub/schedule'

const runner = startScheduleRunner()

const server = createServer((_request, response) => {
  response.end('ok')
})

server.listen(3000)

process.once('SIGTERM', () => {
  runner.stop()
  server.close()
})
```

## Matching behavior

The runner checks enabled Runtime Schedules on an interval. The default interval is one minute.

For each scan, it floors the current time to the current UTC minute and matches Runtime Schedule cron expressions against that minute. It does not backfill missed minutes after process downtime, slow scans, deploys, or clock jumps.

## Concurrency and failures

`concurrency` bounds how many schedule executions this runner instance dispatches at once. The default is `1`.

When a handler fails, the run and attempt are marked `failed`, the error is passed to `onError` when provided, and the runner keeps scanning future minutes. The current runner does not retry failed attempts.

Before dispatching, the runner checks whether a run record already exists for the Runtime Schedule id and scheduled minute. That prevents duplicate dispatch from the same store when one active runner owns the store.

## Single active runner per store

Run only one active runner against a given Runtime Schedule store and Schedule Run store.

The current runner does not provide distributed claiming or leases. If two server processes scan the same store at the same time, both can decide a schedule is due before either has written a run record.

Use one elected process, one singleton service, or a deployment topology that guarantees only one active runner for each store. For anything else, treat this runner as a development or simple self-hosted primitive and keep distributed scheduling outside this package for now.

For the explicit scope limits, read [Boundaries](./boundaries).
