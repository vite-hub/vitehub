---
title: Schedule hosts
description: See the cron files each host gets, how the Node process runtime works, and how to inspect schedules in development.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Failed runs

When a handler throws, ViteHub logs `[vitehub:schedule] Schedule "<name>" failed (cron "<cron>").` with the message, stack, `status`, and `cause` chain. Other schedules on that cron still finish. Then the run rejects with the error (an `AggregateError` for several), so the host marks the cron call as failed. ViteHub does not retry; the next cron tick runs it again.

## Provider output

Provider output is the cron config that the build writes for your host.

| Mode | Output | Nuance |
| --- | --- | --- |
| `auto` | Picks the output for the current build. | Default for Vite projects. |
| `standalone` | Writes the build host's wake output outside Nitro. | ViteHub writes the output. For another host, build for that host. |
| `nitro` | Writes Nitro output: the Cloudflare module and plugin, or the Netlify scheduled functions. | Nitro sets up the host's cron. |
| `false` | Writes nothing. | Runtime helpers still work when you start runs yourself. |

| Host | Static Schedule output |
| --- | --- |
| Cloudflare | Cron triggers and the Cloudflare schedule entry. |
| Vercel | Vercel cron output. |
| Netlify | One scheduled function per schedule. In a Nitro build, `auto` and `nitro` write each one next to Nitro's server function with its own server bundle copy, so it has the same plugins, Database, and other primitives as a request. `standalone` bundles it outside Nitro, without them. |
| Deno | `Deno.cron`, loaded by the generated Deno server. |
| Node or Docker | None. The Process Runtime (`runtime: { driver: 'process' }`) runs schedules in the server process. |

When a Definition has no `cron`, the build adds the `vitehub/started-schedules` Schedule with the cron `* * * * *`. Each host wakes it like the other Static Schedules, and it runs the Schedules that code started with [`startSchedule()`](/docs/schedule/server-api#start-a-schedule-from-code). On Cloudflare it is one more Cron Trigger.

Node has no host cron, so `vitehub({ host: 'node', schedule: true })` fails the build with `VITE_HUB_R0137`. Either:

- Set `schedule: { runtime: { driver: 'process' } }` to run them in the server process.
- Set `schedule: { providerOutput: false }` when your code or an external cron starts them, such as with `vitehub schedule run <name> --url <origin>`.

Only builds check this, so `vite dev` works with `schedule: true`.

With the Process Runtime on Node, leave `providerOutput` unset, `'auto'`, or `false`. `'nitro'` and `'standalone'` hand the wake to the provider, so they fail a Node build even with `runtime` set.

Each build writes one host's output and removes output that an earlier build wrote for another host. With Nitro, the host is Nitro's preset. Without Nitro, it comes from `nitro.preset` in the Vite config, then `NITRO_PRESET`, `SERVER_PRESET`, and `VITEHUB_HOST`. With no known host, it writes output for every host above.

::warning
Provider Wake output requires a static five-field cron string compatible with generated provider output. A Static Schedule with a `timeZone` gets a UTC cron that covers each offset of the time zone, and the runtime checks the local time on each wake. Write that `timeZone` as a string literal.
::

## Run and inspect Schedules during development

`vitehub()` adds the `vitehub schedule` commands, which call the [Console RPC](/docs/console/operations). `hubSchedule()` alone adds none. Start the Vite dev server, then run a manual schedule or list runs from another terminal.

```bash [Terminal]
pnpm vitehub schedule run daily-report
pnpm vitehub schedule runs daily-report --limit 5 --json
pnpm vitehub schedule attempts <runId>
```

The commands use the same run store and registry as the server. Read [CLI](/docs/development/cli#run-and-inspect-schedules) for every command and option.

The Console Schedules page lists the schedules, with cron and time zone under the process driver. `manual: true` schedules show a run action when Console invocation is on. Each Schedule that code started has its own row with its id, time or cron, and payload. `vitehub schedule list`, `start`, and `cancel` read and change the same Schedules.

The CLI and the Console hide credentials in URLs, bearer tokens, and secret assignments in error messages.

| Host | `vitehub schedule` | Console Schedules page |
| --- | --- | --- |
| Vite + Nitro | Yes. They call the dev server's Console RPC in the Nitro dev environment. | Definitions and a run action. |
| Nuxt 5 | Yes. Nitro runs in the Vite process, as on Vite + Nitro. Use `--url http://localhost:3000` when the dev server file is not found. | Definitions and a run action. |
| Plain Vite without Nitro | No. There is no Console RPC. | Not available. |
| Deployed runtime | `vitehub schedule runs` and `attempts` call the Console with `--url` and Console credentials. `schedule run --url` needs `console.invoke` and signs with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` when it is set. | Definitions, when the Console is on. |

::warning
Memory stores lose runs on restart. Use a KV store to keep them.
::

## Production checks

Schedule Runs, Schedule Run Attempts, retry policy, overlap policy, and dedupe policy belong to Schedule. Naming a policy does not imply every policy is configurable in the first version.

Provider Wake output is UTC. A Static Schedule Definition with a `timeZone` wakes on a wider UTC cron and runs only at its local times, on every host. Each run gets an `idempotencyKey` for its occurrence; host cron output does not store runs, so pass the key to the work that must happen once.
