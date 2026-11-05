---
title: Use Vercel Cron Jobs in a Vite app with ViteHub
description: Run Vercel Cron Jobs from a Vite app with ViteHub. Write the cron and handler in one file, and the build adds the Vercel cron entry and its function.
navigation.title: Vercel Cron Jobs
navigation.order: 26
navigation.group: Server work
icon: i-simple-icons-vercel
---

To run a Vercel Cron Job from a Vite app, set `preset: 'vercel'` and `schedule: true` in `vitehub()`, then add a file in `server/schedules/` that exports `defineSchedule({ cron, handler })`. The build writes one `crons` entry and one Vercel Function for each file. Vercel calls that function at the cron time, and the function runs your handler. You do not edit `vercel.json`.

## What Vercel Cron Jobs is

[Vercel Cron Jobs](https://vercel.com/docs/cron-jobs) calls a Vercel Function on a cron schedule. At the cron time, Vercel sends an HTTP `GET` request to a path of the production deployment. Cron Jobs is available on all plans.

ViteHub writes the cron path, the cron entry, and the function that runs your handler. You write the cron expression and the handler in one file.

## Set up Vercel Cron Jobs

### Enable Schedule with the Vercel preset

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', schedule: true })],
})
```

The `vercel` preset writes Vercel Build Output to `.vercel/output`. `vitehub()` includes the Nitro Vite plugin. See [Schedule configuration](/docs/schedule/configure) for every option.

### Define a schedule

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from 'vite-hub/schedule'

// Runs every day at 08:00 UTC
export default defineSchedule({
  cron: '0 8 * * *',
  // Lets you start the schedule by hand to test it
  manual: true,
  async handler({ scheduledAt }) {
    console.log('Daily report for', scheduledAt.toISOString())
  },
})
```

The file name is the schedule name, `daily-report`. Write `cron` and `manual` as literal values, because the build reads them from the source file. See [Schedule Definition options](/docs/schedule/configure#schedule-definition-options).

### Protect the cron function with `CRON_SECRET`

Add a `CRON_SECRET` environment variable to the Vercel project. Vercel recommends a random string of at least 16 characters. Vercel sends its value as `Authorization: Bearer <CRON_SECRET>` when it calls a cron job. The generated function compares that header with `CRON_SECRET` and returns `401` when they differ.

When `CRON_SECRET` is not set, the generated function does not check the header. Any client that knows the path can then run the schedule. Set the secret before you deploy a schedule that changes data. See [securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

## What the build generates

`vite build` adds one entry to the `crons` array in `.vercel/output/config.json` for each Static Schedule Definition:

```json [.vercel/output/config.json]
{
  "crons": [
    { "path": "/api/vitehub/schedules/vercel/daily-report", "schedule": "0 8 * * *" }
  ]
}
```

It also writes the function for that path in `.vercel/output/functions/api/vitehub/schedules/vercel/daily-report.func/`. The function loads the Definition, runs the handler, and returns `204`. Cron entries that your app already has keep their place. ViteHub replaces only the entries under `/api/vitehub/schedules/vercel/`.

## Cron rules on Vercel

Vercel reads every cron expression in UTC. ViteHub checks each cron at build time, so a cron that Vercel cannot run fails the build with `SCHEDULE_R0003`:

- The cron must have five fields that use only digits, `*`, `,`, `/`, and `-`. Names such as `MON` or `JAN` fail.
- The day of the month and the day of the week cannot both have a value. One of them must be `*`.
- A Definition that sets a `timeZone` other than `UTC` fails. Write the cron in UTC, or run the schedule with the [process driver](/docs/schedule/configure#run-a-static-schedule-in-a-time-zone) on a long-lived Node host.

These rules match the [Vercel cron expression limits](https://vercel.com/docs/cron-jobs#cron-expression-limitations).

## How to run a Vercel cron job locally

Vercel does not run cron jobs on a local dev server. To test the handler, start the Vite dev server:

```bash [Terminal]
pnpm dev
```

Then run the schedule by hand from another terminal:

```bash [Terminal]
pnpm vitehub schedule run daily-report
pnpm vitehub schedule runs daily-report --limit 5
```

`schedule run` needs `manual: true` in the Definition. It runs the handler in the dev server, records a Schedule Run, and prints its status. `schedule runs` lists the recorded runs. Read [Run and inspect Schedules during development](/docs/schedule/hosts#run-and-inspect-schedules-during-development).

To check the Vercel output, build the app and read the generated config:

```bash [Terminal]
pnpm vite build
cat .vercel/output/config.json
```

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root. Vercel calls the cron paths on the production deployment. The project **Settings** page lists them under **Cron Jobs**, with a link to their logs.

To run a schedule on the deployment outside its cron time, use `vitehub schedule run daily-report --url https://your-app.vercel.app`. The deployment needs the [Console](/docs/development/console) with `invoke` enabled. When `VITEHUB_DISPATCH_KEY` is set, the CLI sends a [signed dispatch](/docs/development/cli#signed-dispatch) instead of a Console login.

## Vercel Cron Jobs limits

These limits come from Vercel. Read [Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

| Plan | Cron jobs per project | Shortest interval | Timing |
| --- | --- | --- | --- |
| Hobby | 100 | Once per day | Any minute in the set hour |
| Pro | 100 | Once per minute | In the minute |
| Enterprise | 100 | Once per minute | In the minute |

On Hobby, a cron that runs more than once per day fails the deployment.

- A cron job has the same maximum duration as other [Vercel Functions](https://vercel.com/docs/functions/limitations#max-duration).
- Vercel does not retry a cron job that fails. ViteHub does not retry it either. The handler error goes to the function log with `[vitehub:schedule]`, and the next cron time runs the schedule again. See [Failed runs](/docs/schedule/hosts#failed-runs).
- Vercel delivers cron calls on a best effort basis. A call can be missed, and the same call can arrive two times. Write handlers that are safe to run again and that catch up on the work since the last success.
- A run that takes longer than the interval can overlap with the next run. Vercel suggests a lock, such as a Redis lock, to stop two runs at the same time.
- Runs from Vercel cron calls do not create Schedule Run records. Schedule records only manual runs and [Process Runtime](/docs/schedule/configure#configure-the-vite-integration) runs. See [Storage](/docs/schedule/configure#storage).

## Move the same schedule to another host

The schedule file stays the same. Change the preset, and the build writes the cron config of the new host:

| Preset | What runs the schedule |
| --- | --- |
| `cloudflare` | A Cloudflare Cron Trigger in the generated `wrangler.json`. |
| `node` | The Process Runtime, with `schedule: { runtime: { driver: 'process' } }`. Use one long-lived process, and enable `kv` to keep Schedule Runs across restarts. |

Cloudflare also reads cron in UTC only. The Process Runtime is the only driver that reads `timeZone`. Read [Schedule hosts](/docs/schedule/hosts#provider-output) for each output.
