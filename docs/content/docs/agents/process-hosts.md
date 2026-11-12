---
title: Process hosts
description: Run one long-lived Node process that admits, recovers, and drains background Agent work.
navigation.title: Process hosts
navigation.order: 77
navigation.group: Advanced
icon: i-lucide-server-cog
navigation.kind: Guides
---

A process host runs background Agent work, such as a pull-request Agent, inside one long-lived Node process. It gives a process capacity limit, an Invocation journal (a record of each run), recovery for work a stopped process left behind, provider session storage, and a graceful drain that finishes running work before the process stops. For work that must continue on another host or across a durable wait, use a [Workflow](/docs/workflows).

::warning
The host works inside one process only. Its `dataDir` must belong to one running process host. It is not a distributed lease or a coordination service for more than one replica.
::

## Create a host

Export the host from a server module. The `run` callback finds work and tracks it only while the host accepts work:

```ts [server/host.ts] fragment
import { createProcessAgentHost } from 'vite-hub/agent/process'

export default await createProcessAgentHost({
  name: 'reviewer',
  dataDir: '.vitehub/reviewer',
  providerCommand: 'codex',
  capacity: {
    concurrency: 4,
    memory: {
      perInvocationBytes: 768 * 1024 * 1024,
      reserveBytes: 1024 * 1024 * 1024,
    },
  },
  async run(reason, { track }, accepting) {
    const jobs = await discoverPullRequests(reason)
    if (accepting()) track(runPullRequests(jobs))
  },
})
```

ViteHub does not attach the host to an Agent Definition. Pass the host's journal and provider session store to the Definition, and share its capacity object with the Driver:

```ts [server/agents/reviewer.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import host from '../host'

export default defineAgent({
  invocations: host.invocations,
  driver: codexDriver({
    capacity: host.capacity,
    sessionStorePath: host.providerSessionStorePath,
  }),
})
```

- `start()` is safe to call more than once. It wakes the reconciler (the loop that calls `run`), which also runs on its interval and on `wake(reason)`.
- `accepting()` becomes false during a drain. Then stop finding or starting work.
- `track()` makes the host's close wait for work that already started.

The host creates `invocations.sqlite` and `provider-sessions.sqlite` below `dataDir`, unless you give an existing `invocations` store. Keep it on persistent storage when provider sessions or recovery must survive a restart.

## Bound a process with capacity

`capacity.concurrency` is the hard maximum of concurrent runs. Queue options control what happens when slots are full. `createProcessAgentCapacity()` can admit fewer new runs under pressure:

```ts [server/agent-capacity.ts]
import { createProcessAgentCapacity } from 'vite-hub/agent/process'

export const sharedCapacity = createProcessAgentCapacity({
  concurrency: 6,
  fallbackConcurrency: 1,
  memory: {
    perInvocationBytes: 512 * 1024 * 1024,
    reserveBytes: 2 * 1024 * 1024 * 1024,
  },
})
```

Use one capacity object for all Agent Definitions that share process resources. Attach it with `driver.capacity`; the host's `capacity` field can return the same object.

- Running Invocations are never stopped to make room.
- Queued Invocations stay in first-in, first-out (FIFO) order and start when the memory sample allows.
- Linux hosts use cgroup v2 memory limits, memory events, and pressure information when available. Other hosts use Node's available-memory signal.
- When a sample fails or is slow, the host uses `fallbackConcurrency`.

## Recover and drain

At start, `createProcessAgentHost()` marks old pending and running records in its recovery scope as failed. In a shared Invocation store, `invocationAgentName` limits recovery to one discovered Agent. When another process holds a claim, the host waits `recoveryTimeoutMs` before it retries. Durable Workflow records are not touched.

On close, a host stops admitting work, then waits for tracked work. The Vite plugin sets up this order for Nitro and adds a drain route:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { processAgentHost } from 'vite-hub/agent/vite'

export default defineConfig({
  plugins: [
    processAgentHost({
      entry: './server/host.ts',
      drainRoute: '/api/agent-drain',
    }),
  ],
})
```

The plugin starts the exported host with Nitro and closes it with the server. `GET /api/agent-drain` returns `{ status: 'starting' | 'accepting' | 'draining' | 'drained' | 'failed' }`: `accepting` after startup, and `failed` when the reconciler failed while it drained or closed. `SIGUSR2` starts a drain. On `SIGTERM` and `SIGINT`, ViteHub closes the host with the other [shutdown drains](#drain-agent-work-on-stop-signals) while HTTP stays up, lets the HTTP server finish, and exits once. A second signal starts no other drain.

::warning
The drain route does not give authorization. Protect it with the same host policy as your other operational routes.
::

## Drain Agent work on stop signals

On a persistent server, ViteHub finishes Agent work on `SIGTERM` and `SIGINT`, then exits, with no code from you. Each package registers its drain once, and all drains run in parallel with one shared time budget. On the first signal, ViteHub:

1. Runs every drain while HTTP stays up, so webhooks still reach durable queues:
   - `agent.webhook-queues` stops the webhook queues. Active deliveries and [early-answered](/docs/agents/channels#answer-slow-webhooks-early) admissions get the budget, and the next process replays what did not finish. A stopped delivery's Invocation stays `running` until the replay finishes it, or ends `failed` if the queue does not run it again.
   - `agent.chat` waits for inline Chat Invocations. One that runs past the budget posts a restart notice with the `HOST_RESTARTED` error, and the next process retries each message once.
   - `agent.process-host` and `agent.process-hosts` close [process hosts](#recover-and-drain).
   - `agent.preparation` stops Workspace preparation, `agent.discord-gateway` the Discord Gateway, and `schedule` the Schedule Process Runtime.
2. Lets the server close HTTP and waits up to 10 seconds for Nitro `close` hooks.
3. Logs a short summary and exits once with code 0.

`VITEHUB_SHUTDOWN_DRAIN_MS` sets the budget and wins over the `shutdown.drainMs` default:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    agent: { shutdown: { drainMs: 45_000 } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      agent: { shutdown: { drainMs: 45_000 } },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      agent: { shutdown: { drainMs: 45_000 } },
    }),
  ],
})
```
:::
::

The default is 0, which stops work at once. Set the host's termination grace period above the budget plus 25 seconds (15 for interrupted work such as a Chat restart notice, 10 for close hooks), such as 90 seconds for a 45-second budget.

The [systemd unit](/docs/frameworks-hosts/node-self-hosted#run-the-server-with-systemd) that the `node` preset writes sets `TimeoutStopSec` from `shutdown.drainMs`.

ViteHub handles stop signals only where the Nitro server does: the `node`, `node-cluster`, `bun`, and `deno` presets. In development, during prerender, on serverless and Cloudflare hosts, and when graceful shutdown is off (srvx turns it off when `CI` or `TEST` is set), the signal keeps its default behavior, and drains run only when Nitro calls its `close` hooks.

- `agent: { shutdown: false }` skips draining inline Chat Invocations.
- `process.__vitehubShutdown` shows the registered drains, the signal, and each drain's result.
- Logs have `shutdown.draining`, `shutdown.drained`, and `shutdown.exited` events.

## Report readiness after warm-up

A fresh process builds trigger registrations, resolves webhook secrets, and connects and migrates Agent State on its first webhook delivery, which waits for it. Some providers do not wait long: GitHub closes the connection after 10 seconds and does not resend.

With libSQL or SQLite Agent State, the generated webhook queue plugin calls `handler.warm()` for every Agent one second after startup, so Agent routes do not compile during the first requests. A request that loads the Agent routes, such as a webhook delivery or a ready-route call, starts warm-up at once. `/api/_vitehub/ready` reports the result:

| State | Status | Body |
| --- | --- | --- |
| Warm-up runs | 503 | `{ ready: false, status: "warming", agents }` |
| Warm-up failed | 503 | `{ ready: false, status: "error", error, retryMs: 5000, agents }` |
| Every Agent is warm | 200 | `{ ready: true, status: "ready", readyAt, agents: { <name>: { durationMs } } }` |

A failed warm-up retries every 5 seconds, because the first delivery would fail the same way. `HEAD` gets no body. The process logs `{ "scope": "vitehub.agent.ready" }` once when ready. With `agent.preparation`, the preparation route also waits for warm-up, and no second route is generated.

Point a Kubernetes readiness probe at the route so the Service sends traffic only to a warm process:

```yaml [deployment.yaml]
readinessProbe:
  httpGet:
    path: /api/_vitehub/ready
    port: 3000
  periodSeconds: 2
  failureThreshold: 1
```

Keep the liveness probe on a route that does not wait for warm-up, or a slow warm-up restarts the process.

## Inspect health and work

`createAgentHealth()` gives a cacheable operational report. It inspects the Driver without an Invocation or a model prompt:

```ts [server/health.ts]
import { createAgentHealth } from 'vite-hub/agent/server'
import agent from './agents/reviewer'
import host from './host'

export const health = createAgentHealth({
  name: 'reviewer',
  agent: () => agent,
  process: host,
})
```

The report has provider readiness, capacity, process diagnostics, and Invocation workload. It is cached for five seconds by default, and concurrent readers share one sample. A timeout returns a degraded report. Health returns HTTP 200 even when degraded, so keep startup readiness and orchestrator restart probes separate.

Expose health or Workspace inspection only with an access policy. `agentHostRoutes()` generates GET and HEAD routes from named exports, each off until you turn it on:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { agentHostRoutes } from 'vite-hub/agent/vite'

export default defineConfig({
  plugins: [
    agentHostRoutes({
      entry: './server/health.ts',
      health: 'health',
    }),
  ],
})
```

The default health route is `/api/health`. Generated routes grant no Console authorization. A Workspace route is off by default, and its path must contain an `:id` parameter.

## Verify a host locally

To test admission independent of machine pressure, use a disposable directory and a custom `sample` function:

```ts
import { createProcessAgentCapacity } from 'vite-hub/agent/process'

const capacity = createProcessAgentCapacity({
  concurrency: 2,
  fallbackConcurrency: 0,
  queue: { maxPending: 10 },
  sample: ({ active }) => ({
    concurrency: active === 0 ? 1 : 0,
    reason: 'test sample',
  }),
})
```

1. Start one host and confirm that `status()` goes from `starting` to `accepting`.
2. Queue more work than its hard limit and check that the extra work stays queued.
3. Send `SIGUSR2`, wait for `draining` then `drained`, and confirm no new work starts.
4. Restart with the same `dataDir` and check the journal for recovered interrupted records.

Run this on a throwaway project before you deploy a host that can change a real repository.
