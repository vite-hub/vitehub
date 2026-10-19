---
title: Schedule hosts
description: Understand Schedule Provider Output, the Process Runtime, development inspection, and production checks.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider output

| Mode | Output | Nuance |
| --- | --- | --- |
| `auto` | Selects the appropriate generated output for the active build context. | Default mode for Vite projects. |
| `standalone` | Writes standalone provider output outside Nitro. | Use when ViteHub owns provider output directly. |
| `nitro` | Writes Nitro Cloudflare module and plugin output. | Use when Nitro owns Cloudflare cron wiring. |
| `false` | Disables generated provider output. | Runtime helpers still work when you wire execution yourself. |

| Host | Static Schedule output |
| --- | --- |
| Cloudflare | Cron trigger output and Cloudflare schedule runtime entry wiring. |
| Vercel | Vercel cron-compatible output for static schedules. |
| Deno | `Deno.cron` output loaded by generated Deno Agent server output. |
| Node or Docker | The Process Runtime (`runtime: { driver: 'process' }`) runs each Definition in the long-lived process. |

::warning
Provider Wake output requires a static five-field UTC cron string compatible with generated provider output. A Static Schedule that sets a `timeZone` other than `UTC` fails the build when the build generates provider output. Runtime Schedules still need an existing Provider Wake or a long-running host to execute due schedules.
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

Provider Wake output is UTC. Static Schedule Definitions can set `timeZone` only with the process driver. Runtime Schedules use UTC by default and can persist an IANA `timeZone` when local clock time must follow daylight-saving changes.
