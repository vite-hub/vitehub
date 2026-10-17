---
title: Process hosts
description: Run one long-lived Node process that admits, recovers, and drains background Agent work.
navigation.title: Process hosts
navigation.order: 74
navigation.group: Operate
icon: i-lucide-server-cog
---

A process host owns background Agent work inside one Node process. It combines a
process-local capacity limit, an invocation journal, recovery for work left by a
stopped process, provider session storage, and a graceful drain. Use it for a
long-lived worker such as a pull-request Agent. Use a [Workflow](/docs/workflows)
when the work must continue on a different host or across a durable wait.

The host is process-local. Its `dataDir` must belong to one running process host;
it is not a distributed lease or a coordination service for multiple replicas.

## Create a host

Export the host from a server module. The `run` callback discovers work and tracks
it only while the host is accepting new work:

```ts [server/host.ts]
import { createProcessAgentHost } from 'vite-hub/agent/runtime/process'

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

The host resources are not attached to an Agent Definition automatically. Wire
the host's journal and provider session store into the definition, and share its
capacity object with the driver:

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import host from '../host'

export default defineAgent({
  invocations: host.invocations,
  driver: {
    model: 'openai/gpt-5.1-mini',
    capacity: host.capacity,
    sessionStorePath: host.providerSessionStorePath,
  },
})
```

`start()` is idempotent and wakes the reconciler at startup. The reconciler checks
for new work on its interval and also wakes when the host calls `wake(reason)`.
`accepting()` becomes false during a drain. Stop discovering or starting work when
it returns false. `track()` keeps the host's close operation waiting for work that
has already started.

The host creates `invocations.sqlite` and `provider-sessions.sqlite` below
`dataDir` unless you provide an existing `invocations` store. Keep the directory
on persistent storage when provider sessions or recovery must survive a restart.

## Bound a process with capacity

`capacity.concurrency` is the hard maximum. Queue options control what happens
when all slots are occupied. `createProcessAgentCapacity()` can lower new
admissions when the host is under pressure:

```ts [server/agent-capacity.ts]
import { createProcessAgentCapacity } from 'vite-hub/agent/runtime/process'

export const sharedCapacity = createProcessAgentCapacity({
  concurrency: 6,
  fallbackConcurrency: 1,
  memory: {
    perInvocationBytes: 512 * 1024 * 1024,
    reserveBytes: 2 * 1024 * 1024 * 1024,
  },
})
```

Reuse one capacity object across Agent Definitions that compete for the same
process resources. Active Invocations are not preempted. Queued Invocations stay
in FIFO order and resume when the sample allows more work. Linux hosts use cgroup
v2 memory limits, memory events, and pressure information when available. Other
hosts use Node's available-memory signal. A failed or slow sample uses
`fallbackConcurrency`.

Attach the returned object to an Agent Definition with `driver.capacity`. The
same object can be returned by the process host's `capacity` field.

## Recover and drain

When `createProcessAgentHost()` starts, it fails old pending and running records
that belong to this host's recovery scope. A shared invocation store uses
`invocationAgentName` to limit that recovery to one discovered Agent. A claim
held by another process is respected for `recoveryTimeoutMs` before the host
tries again. Durable Workflow records are outside this process recovery path.

Closing a host stops admission first, then waits for tracked work. The Vite
plugin installs this order for Nitro and exposes a drain route:

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

The plugin starts the exported host with Nitro, closes it with the server, and
serves `GET /api/agent-drain` with `{ status: 'starting' | 'accepting' | 'draining' | 'drained' | 'failed' }`.
The host reports `accepting` after startup; `failed` means the reconciler
encountered a failure while draining or closing.
`SIGUSR2` starts a drain. `SIGTERM` and `SIGINT` stop admission, wait for the
host close, then let the HTTP server finish its shutdown. A second signal does
not start another drain. The process exits after this drain and the
[Agent drain](#drain-agent-work-on-stop-signals) settle.

Do not expose the drain route as an authorization mechanism. Protect it with the
same host policy as other operational routes.

## Drain Agent work on stop signals

A persistent Node server with libSQL or SQLite Agent State drains Agent work
on `SIGTERM` and `SIGINT`, then exits. The generated webhook queue plugin does
this; no application code is needed. On the first signal it:

1. Stops the webhook queues. Active deliveries get the drain budget, and the
   persisted queue replays the deliveries that it aborts after the restart.
2. Waits for inline Chat Invocations with `drainInlineChatInvocations()`.
   Invocations that outlast the budget post a restart notice with the
   `HOST_RESTARTED` error, and the next process retries each message once.
3. Waits up to 10 seconds for Nitro's `close` hooks when the server closes HTTP.
4. Waits for other registered drains, such as the `processAgentHost()` stop
   handler, logs a short summary, and exits once.

The budget comes from `VITEHUB_SHUTDOWN_DRAIN_MS`. The `shutdown.drainMs` option
sets its default, and the variable wins when it is set:

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

The default is 0, which interrupts the work at once. Give the host a
termination grace period longer than the budget plus 25 seconds: 15 seconds
for interrupted Chat Invocations to post their notice and 10 seconds for the
close hooks. For example, use 90 seconds with a 45-second budget.

The drain does not run in development, during prerender, or outside Node.
Ephemeral hosts do not install it. Set `agent: { shutdown: false }` when the
application installs its own stop handler. Every stop handler registers its
drain in `process.__vitehubShutdown`, so you can inspect the drains that run.

## Inspect health and work

Use `createAgentHealth()` for a cacheable operational report. It inspects the
Agent Driver without creating an Invocation or sending a model prompt:

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

The report includes provider readiness, capacity, process diagnostics, and
invocation workload. Reports are cached for five seconds by default, and one
sample is shared by concurrent readers. A timeout returns a degraded report.
Health is an operational report and returns HTTP 200 even when degraded. Keep
startup readiness and orchestrator restart probes separate.

Expose health or Workspace inspection only when the application has an access
policy. `agentHostRoutes()` generates opt-in GET and HEAD routes from named
exports:

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

The default health route is `/api/health`. The generated route does not grant
Console authorization. A Workspace route is also opt-in and must contain an
`:id` parameter.

## Verify a host locally

Use a disposable directory and a custom `sample` function to exercise admission
without depending on the machine's current pressure:

```ts
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

Start one host, confirm `status()` changes from `starting` to `accepting`, enqueue
more work than its hard limit, and check that the extra work stays queued. Send
`SIGUSR2`, wait for `draining` and then `drained`, and confirm that no new work
starts during the drain. Restart with the same `dataDir` and inspect the journal
to confirm that interrupted records are recovered. Run this probe against a
throwaway project before deploying a host that can change a real repository.
