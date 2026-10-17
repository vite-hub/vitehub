---
title: Schedule hosts
description: Understand how each host runs Static Schedules, development inspection, and production checks.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## How each host runs a Static Schedule

`vite build` registers each Static Schedule Definition as a Nitro task named `vitehub:schedule:<name>` and adds its cron to Nitro `scheduledTasks`. Nitro then wires the host scheduler.

| Host (Nitro preset) | Who fires the Schedule |
| --- | --- |
| Node or Docker (`node-server`) | Nitro runs [croner](https://croner.56k.guru/) in the server process. |
| Cloudflare (`cloudflare-module`) | Nitro adds the cron to `triggers.crons` in `.output/server/wrangler.json`. The Worker `scheduled()` handler runs the task. |
| Vercel (`vercel`) | Nitro adds the cron to `crons` in `.vercel/output/config.json`, with the `/_vercel/cron` route. Set `CRON_SECRET` to protect the route. |
| Netlify (`netlify`) | Nitro has no Netlify scheduler. ViteHub writes `.netlify/v1/functions/vitehub-schedule-<name>.mjs` with `config.schedule`. It calls the Nitro route `POST /_vitehub/schedules/run`. `CRON_SECRET`, or a secret that each build generates, protects the route. |
| Deno Deploy (`deno-deploy`) | Nitro has no Deno Deploy scheduler. A ViteHub Nitro plugin calls `Deno.cron()` when the server module loads. |

::warning
A Static Schedule needs a static five-field UTC cron string that Cloudflare, Vercel, and Netlify all accept.
::

## Run and inspect Schedules during development

`hubSchedule()` contributes the `vitehub schedule` CLI namespace. Start the Vite Development Server, then run a manual Definition or list recorded runs from another terminal.

```bash [Terminal]
pnpm vitehub schedule run daily-report
pnpm vitehub schedule runs daily-report --limit 5 --json
pnpm vitehub schedule attempts <runId>
```

The commands use the same Schedule Run store and registry as the running server. Read [CLI](/docs/development/cli#run-and-inspect-schedules) for every command and option.

The Console Schedules page lists the discovered Schedule Definitions. Definitions with `manual: true` show a run action when Console invocation is enabled.

Both surfaces redact credentials in URLs, bearer tokens, and secret assignments in error messages.

| Host | `vitehub schedule` | Console Schedules page |
| --- | --- | --- |
| Vite + Nitro | Supported. The endpoint forwards each operation into the Nitro dev environment. | Definitions. |
| Nuxt with Nitro 3 | Supported. Nitro runs in the Vite process, so the endpoint works as on Vite + Nitro. Use `--url http://localhost:3000`, or `--server` for `schedule run`. | Definitions. |
| Nuxt with Nitro 2 | Not supported. Nitro does not run in the Vite process. | Definitions. |
| Plain Vite without Nitro | Not supported. The endpoint returns status 501. | Not available. |
| Deployed runtime | Not exposed. The endpoint exists only on the Development Server. `vitehub schedule run --url` uses the Console. | Definitions, when the Console is enabled. |

Memory stores lose runs when the runtime restarts. Configure a KV store to keep them.

## Production checks

Schedule Runs, Schedule Run Attempts, retry policy, overlap policy, and dedupe policy belong to Schedule. Naming a policy does not imply every policy is configurable in the first version.

Static Schedule Definitions and Provider Wake output remain UTC.
