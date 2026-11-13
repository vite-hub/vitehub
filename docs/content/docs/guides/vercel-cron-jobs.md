---
title: Use Vercel Cron Jobs in a Vite app with ViteHub
description: Run Vercel Cron Jobs from a Vite app with ViteHub. Write the cron and handler in one file, and the build adds the Vercel cron entry and its function.
navigation.title: Vercel Cron Jobs
navigation.order: 26
navigation.group: Server work
icon: i-simple-icons-vercel
---

Set `host: 'vercel'` and `schedule: true` in `vitehub()`, then add a file in `server/schedules/` that exports `defineSchedule({ cron, handler })`. The build writes one `crons` entry and one Vercel Function per file. Vercel calls that function at the cron time, and it runs your handler. You do not edit `vercel.json`.

## What Vercel Cron Jobs is

[Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), on all plans, calls a Vercel Function on a cron schedule. At the cron time, Vercel sends an HTTP `GET` to a path of the production deployment.

You write the cron expression and handler in one file. ViteHub writes the path, the cron entry, and the function.

## Set up Vercel Cron Jobs

### Enable Schedule with the Vercel host

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel', schedule: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', schedule: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', schedule: true })],
})
```
:::
::

The `vercel` host writes Vercel Build Output to `.vercel/output`. `vitehub()` includes the Nitro Vite plugin. See [Schedule configuration](/docs/schedule/configure) for all options.

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

The file name is the schedule name, `daily-report`. The build reads `cron` and `manual` from the source, so write them as literal values. See [Schedule Definition options](/docs/schedule/configure#schedule-definition-options).

### Protect the cron function with `CRON_SECRET`

Add a `CRON_SECRET` environment variable to the Vercel project. Vercel recommends a random string of at least 16 characters. Vercel sends it as `Authorization: Bearer <CRON_SECRET>`, and the generated function returns `401` if the header does not match.

::warning
Without `CRON_SECRET`, the function does not check the header, so anyone who knows the path can run the schedule. Set it before you deploy a schedule that changes data. See [securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
::

## What the build generates

`vite build` adds one `crons` entry in `.vercel/output/config.json` per static Schedule Definition (schedule file):

```json [.vercel/output/config.json]
{
  "crons": [
    { "path": "/api/vitehub/schedules/vercel/daily-report", "schedule": "0 8 * * *" }
  ]
}
```

It also writes the function in `.vercel/output/functions/api/vitehub/schedules/vercel/daily-report.func/`. The function loads the Definition, runs the handler, and returns `204`. ViteHub replaces only entries under `/api/vitehub/schedules/vercel/` and keeps your other cron entries.

## Cron rules on Vercel

Vercel reads cron in UTC. ViteHub checks each cron at build time, and a cron that Vercel cannot run fails the build with `SCHEDULE_R0003`:

- The cron must have five fields that use only digits, `*`, `,`, `/`, and `-`. Names such as `MON` or `JAN` fail.
- The day of the month and the day of the week cannot both have a value. One of them must be `*`.
- A Definition with a [`timeZone`](/docs/schedule/configure#run-a-static-schedule-in-a-time-zone) gets a UTC cron that covers each offset, such as `0 6,7 * * *` for 08:00 in `Europe/Madrid`. Vercel Hobby runs a cron job at most once a day, so it rejects that cron. Set a UTC `cron` override for Hobby, or use Pro.

These rules match the [Vercel cron expression limits](https://vercel.com/docs/cron-jobs#cron-expression-limitations).

## How to run a Vercel cron job locally

Vercel does not run cron jobs locally. To test the handler, start the dev server:

```bash [Terminal]
pnpm dev
```

Then run the schedule by hand from another terminal:

```bash [Terminal]
pnpm vitehub schedule run daily-report
pnpm vitehub schedule runs daily-report --limit 5
```

`schedule run` needs `manual: true`. It runs the handler in the dev server, records a Schedule Run, and prints its status. `schedule runs` lists recorded runs. See [Run and inspect Schedules during development](/docs/schedule/hosts#run-and-inspect-schedules-during-development).

To check the Vercel output, build and read the config:

```bash [Terminal]
pnpm vite build
cat .vercel/output/config.json
```

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root. Vercel calls the cron paths on production. The project **Settings** page lists them under **Cron Jobs**, with their logs.

To run a schedule outside its cron time, use `vitehub schedule run daily-report --url https://your-app.vercel.app`. The deployment needs the [Console](/docs/development/console) with `invoke` enabled. The CLI [signs the call](/docs/development/console#sign-console-requests) with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, so it needs no Console login.

## Vercel Cron Jobs limits

Vercel sets these limits. Read [Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

| Plan | Cron jobs per project | Shortest interval | Timing |
| --- | --- | --- | --- |
| Hobby | 100 | Once per day | Any minute in the set hour |
| Pro | 100 | Once per minute | In the minute |
| Enterprise | 100 | Once per minute | In the minute |

On Hobby, a cron that runs more than once per day fails the deployment.

- A cron job has the same maximum duration as other [Vercel Functions](https://vercel.com/docs/functions/limitations#max-duration).
- Neither Vercel nor ViteHub retries a failed cron job. The error goes to the function log with `[vitehub:schedule]`, and the next cron time runs it again. See [Failed runs](/docs/schedule/hosts#failed-runs).
- Delivery is best effort: a call can be missed or arrive twice. Make handlers safe to run again, and catch up on work since the last success.
- A run longer than the interval can overlap the next one. Vercel suggests a lock, such as a Redis lock.
- Vercel cron calls create no Schedule Run records. Only manual runs and [Process Runtime](/docs/schedule/configure#configure-the-vite-integration) runs do. See [Storage](/docs/schedule/configure#storage).

## Move the same schedule to another host

The schedule file stays the same. Change the host, and the build writes the new host's cron config:

| Host | What runs the schedule |
| --- | --- |
| `cloudflare` | A Cloudflare Cron Trigger in the generated `wrangler.json`. |
| `node` | The Process Runtime, with `schedule: { runtime: { driver: 'process' } }`. Use one long-lived process, and enable `kv` to keep Schedule Runs after restarts. |

Cloudflare also reads cron in UTC only, and ViteHub handles `timeZone` there the same way. Read [Schedule hosts](/docs/schedule/hosts#provider-output) for each output.
