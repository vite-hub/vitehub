---
title: Diagnostics
description: Report Agent Invocation outcomes and scoped runtime resource observations.
navigation.title: Diagnostics
navigation.order: 126
navigation.group: External context
icon: i-lucide-gauge
---

`diagnostics()` is an opt-in operational Capability. It reports a terminal event for every Agent Invocation and can sample resources through a Runtime inspector. Reporters receive structured events, so an application can write JSON logs, metrics, or another operations sink without coupling the Agent Definition to one dashboard.

## Observe a Node service

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

Reporter and inspector failures are contained. They produce a local diagnostic and do not replace a successful Agent result.

## Event contract

The Capability reports:

| Event | When |
| --- | --- |
| `agent.invocation.terminal` | The invocation completes or fails. Includes outcome, duration, run ID when present, and a bounded structured error. |
| `agent.resource.snapshot` | Sampling starts, finishes, or reaches the heartbeat interval. |
| `agent.resource.peak` | A peak observation grows by at least `peakStepBytes`. |
| `agent.resource.inspect.failed` | The inspector fails or exceeds its timeout. |

Resource observations declare a `scope`, `source`, `unit`, and numeric `value`. The Node adapter uses `process` for Node memory and CPU, `host` for available host memory, and `service` for Linux cgroup v2 values. A service observation provides correlation with an invocation's run ID; it is not per-invocation attribution when multiple invocations share the service.

Unsupported sources are recorded in `support`. Unlimited cgroup values are omitted rather than reported as zero. This keeps small machines and non-Linux hosts honest without requiring application-specific `/proc` parsing.

## Sampling behavior

Sampling is bounded to one active inspection and one coalesced pending reason. A slow inspector cannot create an unbounded polling backlog. Finish supersedes a stale poll and waits for the final observation before the Capability closes.

`diagnostics()` is separate from `otlp()`: diagnostics records operator health and resource pressure, while OTLP exports the Agent Invocation trace. Keeping the lanes separate prevents a broken telemetry receiver from recursively hiding its own delivery failure.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `reporter` | `RuntimeDiagnosticReporter` | Structured console output | Receives operational events. |
| `resources` | `RuntimeResourceInspector` | None | Enables scoped resource sampling. |
| `interval` | `number` | `10000` | Resource polling interval in milliseconds. |
| `heartbeat` | `number` | `60000` | Maximum interval between snapshot events in milliseconds. |
| `peakStepBytes` | `number` | `67108864` | Minimum peak increase before a peak event. |
| `timeout` | `number` | `1000` | Maximum duration of one resource inspection in milliseconds. |

## Related

- [OTLP](/docs/capabilities/otlp)
- [Invocations](/docs/agents/invocations)
- [Runtime context](/docs/concepts/runtime-context)
