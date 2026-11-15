---
title: Diagnostics
description: Report how each Agent run ends and track memory and CPU use with a runtime inspector.
navigation.title: Diagnostics
navigation.order: 226
navigation.group: Capabilities
icon: i-lucide-gauge
---

`diagnostics()` reports how each Invocation (one Agent run) ends, and optionally its memory and CPU use.

- It always reports one terminal event at the end.
- With `resources`, it samples process, host, or service resources through a runtime inspector.
- It adds no model tool and wraps no Server Primitive.
- It sends structured events to your reporter, for JSON logs, metrics, or another sink.

## Configure diagnostics

The Node adapter watches process, host, and Linux cgroup resources:

```ts [server/agents/worker.ts]
import { defineAgent } from 'vite-hub/agent'
import { diagnostics, nodeRuntimeResources } from 'vite-hub/agent/capabilities'

export default defineAgent({
  name: 'worker',
  capabilities: [
    diagnostics({
      resources: nodeRuntimeResources(),
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The default reporter logs to the console. Pass `reporter` for your own sink:

```ts [server/agents/worker.ts]
import { defineAgent } from 'vite-hub/agent'
import { diagnostics } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from 'vite-hub/agent/capabilities'

export default defineAgent({
  name: 'worker',
  capabilities: [
    diagnostics({
      resources: nodeRuntimeResources(),
      // Send each event to your own log store
      reporter: async (event) => {
        await fetch('https://logs.example.com/ingest', { method: 'POST', body: JSON.stringify(event) })
      },
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

## How diagnostics works

With `resources`, a monitor runs from preparation until the run closes. At the end, it reports `agent.invocation.terminal`.

Reporter or inspector failures never break the run or replace a successful result:

- A failed or timed-out inspector sends `agent.resource.inspect.failed` to the reporter.
- A failed reporter writes a local `agent.diagnostics.report.failed` warning.

### Event contract

| Event | When |
| --- | --- |
| `agent.invocation.terminal` | The run completes, fails, or is cancelled. Has `outcome` (`completed`, `failed`, or `cancelled`), duration, run ID when present, and a bounded structured error. |
| `agent.resource.snapshot` | Sampling starts, finishes, or reaches the heartbeat interval. |
| `agent.resource.peak` | A peak observation grows by at least `peakStepBytes`. |
| `agent.resource.inspect.failed` | The inspector fails or exceeds its timeout. |

Each observation has a `scope`, `source`, `unit`, and numeric `value`. Node adapter scopes are `process` (Node memory and CPU), `host` (available host memory), and `service` (Linux cgroup v2).

A service observation carries the run ID but does not isolate one run when several share the service.

Unsupported sources go in `support`. Unlimited cgroup values are left out, not reported as zero, so values stay correct on small machines and non-Linux hosts without parsing `/proc`.

### Sampling behavior

Sampling is bounded, so a slow inspector or reporter cannot queue polls without limit:

- One inspection runs at a time; pending reasons merge.
- Events arrive in order. `timeout` limits each delivery.
- The finish sample replaces an old poll, and closing waits for the final observation.

`diagnostics()` records operator health and resource pressure; `otlp()` exports the trace. They stay separate so a broken telemetry receiver cannot hide its own delivery failure.

## Requirements

- `diagnostics()` needs no Server Primitive.
- Sampling needs a `RuntimeResourceInspector`, such as `nodeRuntimeResources()` from `vite-hub/agent/capabilities`.
- `interval` must not exceed `heartbeat`. Durations are positive milliseconds.

## Security and approval

There is no tool, so no approval step. Events have outcome, timing, run IDs, and resource values, never prompts or model output.

> [!WARNING]
> A failed run's terminal event includes a normalized error with its stack trace. Send events only to a sink allowed to store server error details.

## Driver support

Model-backed, provider-backed, and custom-run-backed Drivers all report terminal events and resource samples.

## Verify diagnostics

Run once with the default reporter and find an `agent.invocation.terminal` object with `outcome: 'completed'` in the log. With `resources`, `agent.resource.snapshot` events appear at start and finish.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `reporter` | `RuntimeDiagnosticReporter` | Structured console output | Receives operational events. |
| `resources` | `RuntimeResourceInspector` | None | Enables scoped resource sampling. |
| `interval` | `number` | `10000` | Polling interval in milliseconds. Not above `heartbeat`. |
| `heartbeat` | `number` | `60000` | Maximum milliseconds between snapshots. |
| `peakStepBytes` | `number` | `67108864` | Minimum peak increase before a peak event. |
| `timeout` | `number` | `1000` | Maximum milliseconds per inspection or delivery. |

## Related pages

- [OTLP](/docs/agents/capabilities/otlp)
- [Invocations](/docs/agents/invocations)
- [Runtime context](/docs/reference/runtime-context)
- [Official capabilities](/docs/agents/capabilities/official)
