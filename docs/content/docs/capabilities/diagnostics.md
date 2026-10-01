---
title: Diagnostics
description: Report Agent Invocation outcomes and scoped runtime resource observations.
navigation.title: Diagnostics
navigation.order: 126
navigation.group: External context
icon: i-lucide-gauge
---

`diagnostics()` reports operational events for each Agent Invocation to an application-owned reporter.
It always reports one terminal event. With `resources`, it also samples process, host, or service resources through a Runtime inspector.
It adds no model-facing tool and does not wrap a Server Primitive. Reporters receive structured events, so the application can write JSON logs, metrics, or another operations sink.

## Configure diagnostics

Use ViteHub's Node adapter to observe process, host, and Linux cgroup resources:

```ts [server/agents/worker.ts]
import { defineAgent } from 'vite-hub/agent'
import { diagnostics } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'

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

The default reporter writes structured console objects. Pass `reporter` to own delivery:

```ts
diagnostics({
  resources: nodeRuntimeResources(),
  reporter: event => operations.write(event),
})
```

## How diagnostics works

When `resources` is set, the Capability starts a resource monitor when the invocation is prepared and stops it when the invocation closes.
When the invocation finishes, the Capability reports `agent.invocation.terminal`.
Reporter and inspector failures are contained. When an inspector fails or times out, the Capability sends `agent.resource.inspect.failed` to the configured reporter. If reporter delivery itself fails, it emits a local `agent.diagnostics.report.failed` warning. Neither failure replaces a successful Agent result.

### Event contract

The Capability reports:

| Event | When |
| --- | --- |
| `agent.invocation.terminal` | The invocation completes, fails, or is cancelled. Includes `outcome` (`completed`, `failed`, or `cancelled`), duration, run ID when present, and a bounded structured error. |
| `agent.resource.snapshot` | Sampling starts, finishes, or reaches the heartbeat interval. |
| `agent.resource.peak` | A peak observation grows by at least `peakStepBytes`. |
| `agent.resource.inspect.failed` | The inspector fails or exceeds its timeout. |

Resource observations declare a `scope`, `source`, `unit`, and numeric `value`. The Node adapter uses `process` for Node memory and CPU, `host` for available host memory, and `service` for Linux cgroup v2 values. A service observation provides correlation with an invocation's run ID; it is not per-invocation attribution when multiple invocations share the service.

Unsupported sources are recorded in `support`. Unlimited cgroup values are omitted rather than reported as zero. This keeps small machines and non-Linux hosts honest without requiring application-specific `/proc` parsing.

### Sampling behavior

Sampling is bounded to one active inspection and one coalesced pending reason. Reporter delivery is ordered and bounded by `timeout`. A slow inspector or reporter cannot create an unbounded polling backlog. Finish supersedes a stale poll and waits for the final observation before the Capability closes.

`diagnostics()` is separate from `otlp()`: diagnostics records operator health and resource pressure, while OTLP exports the Agent Invocation trace. Keeping the lanes separate prevents a broken telemetry receiver from recursively hiding its own delivery failure.

## Requirements

`diagnostics()` needs no primitive. Resource sampling requires a `RuntimeResourceInspector`, such as `nodeRuntimeResources()` from `vite-hub/runtime/node`.
`interval` cannot exceed `heartbeat`. All durations must be positive milliseconds.

## Security and approval

`diagnostics()` adds no model-facing tool, so the Agent cannot call it and there is no approval step.
Events contain outcome, timing, run IDs, and resource values. They do not contain prompts or model output.
A failed invocation's terminal event includes a normalized error with its stack trace. Send events only to a sink that may store server error details.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Reports terminal events and resource samples. |
| Provider-backed | Reports terminal events and resource samples. |
| Custom-run-backed | Reports terminal events and resource samples. |

## Verify diagnostics

Run one invocation with the default reporter and confirm that the server log contains an `agent.invocation.terminal` object with `outcome: 'completed'`.
With `resources` set, confirm that `agent.resource.snapshot` events appear at start and finish.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `reporter` | `RuntimeDiagnosticReporter` | Structured console output | Receives operational events. |
| `resources` | `RuntimeResourceInspector` | None | Enables scoped resource sampling. |
| `interval` | `number` | `10000` | Resource polling interval in milliseconds. Must not exceed `heartbeat`. |
| `heartbeat` | `number` | `60000` | Maximum interval between snapshot events in milliseconds. |
| `peakStepBytes` | `number` | `67108864` | Minimum peak increase before a peak event. |
| `timeout` | `number` | `1000` | Maximum duration of one resource inspection or reporter delivery in milliseconds. |

## Related pages

- [OTLP](/docs/capabilities/otlp)
- [Invocations](/docs/agents/invocations)
- [Runtime context](/docs/concepts/runtime-context)
- [Official capabilities](/docs/capabilities/official-capabilities)
