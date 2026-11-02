---
title: Schedule hosts
description: Understand Schedule Provider Output, the Process Runtime, development inspection, and production checks.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Failed runs

When a Static Schedule handler throws, ViteHub logs `[vitehub:schedule] Schedule "<name>" failed (cron "<cron>").` with the error message, stack, `status`, and `cause` chain. Other schedules on the same cron still finish. The run then rejects with the error, or with an `AggregateError` when more than one schedule failed, so the host marks the cron invocation as failed. ViteHub does not retry a failed run. The next cron tick runs the schedule again.

## Provider output

| Mode | Output | Nuance |
| --- | --- | --- |
| `auto` | Selects the appropriate generated output for the active build context. | Default mode for Vite projects. |
| `standalone` | Writes the wake output of the build's host outside Nitro. | Use when ViteHub owns provider output directly. To get the output of another host, build with that host. |
| `nitro` | Writes Nitro Cloudflare module and plugin output. | Use when Nitro owns Cloudflare cron wiring. |
| `false` | Disables generated provider output. | Runtime helpers still work when you wire execution yourself. |

| Host | Static Schedule output |
| --- | --- |
| Cloudflare | Cron trigger output and Cloudflare schedule runtime entry wiring. |
| Vercel | Vercel cron-compatible output for static schedules. |
| Netlify | One Netlify scheduled function per static schedule. |
| Deno | `Deno.cron` output loaded by generated Deno Agent server output. |
| Node or Docker | No host output. The Process Runtime (`runtime: { driver: 'process' }`) runs each Definition in the long-lived process. |

A Node server has no host cron. `vitehub({ preset: 'node', schedule: true })` fails the build with `VITE_HUB_R0137`, because nothing would run its Schedules. Set `schedule: { runtime: { driver: 'process' } }` to run them in the server process. Set `schedule: { providerOutput: false }` when your own code or an external cron starts them, for example through `/_vitehub/schedules/run`. The check runs only for builds, so `vite dev` still works with `schedule: true`.

Schedule writes the output of one host per build. With Nitro, the host is the preset that Nitro resolves. Without Nitro, it comes from `nitro.preset` in the Vite config, then `NITRO_PRESET`, `SERVER_PRESET`, and `VITEHUB_HOSTING`. A build also removes the Schedule output that an earlier build wrote for another host. When no host is known, the build writes the output of every host above.

::warning
Provider Wake output requires a static five-field UTC cron string compatible with generated provider output. A Static Schedule that sets a `timeZone` other than `UTC` fails the build when the build generates provider output.
::

## Run and inspect Schedules during development

`vitehub()` contributes the `vitehub schedule` commands, because they call the [Console RPC](/docs/development/operations). An app that adds `hubSchedule()` without `vitehub()` has no such commands. Start the Vite Development Server, then run a manual Definition or list recorded runs from another terminal.

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
| Vite + Nitro | Supported. The commands call the Console RPC of the dev server, which runs in the Nitro dev environment. | Definitions and a run action. |
| Nuxt with Nitro 3 | Supported. Nitro runs in the Vite process, so the commands work as on Vite + Nitro. Use `--url http://localhost:3000` when the dev server file is not found. | Definitions and a run action. |
| Nuxt with Nitro 2 | Not supported. Nitro does not run in the Vite process. | Definitions. |
| Plain Vite without Nitro | Not supported. There is no Console RPC to call. | Not available. |
| Deployed runtime | `vitehub schedule runs` and `attempts` call the Console with `--url` and Console credentials. `schedule run --url` needs `console.invoke`, and signs with `VITEHUB_DISPATCH_KEY` when it is set. | Definitions, when the Console is enabled. |

Memory stores lose runs when the runtime restarts. Configure a KV store to keep them.

## Production checks

Schedule Runs, Schedule Run Attempts, retry policy, overlap policy, and dedupe policy belong to Schedule. Naming a policy does not imply every policy is configurable in the first version.

Provider Wake output is UTC. Static Schedule Definitions can set `timeZone` only with the process driver.
