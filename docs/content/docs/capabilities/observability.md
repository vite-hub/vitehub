---
title: Observability
description: Attach lifecycle events, model instrumentation, and eval-visible finish metadata.
navigation.title: Observability
navigation.order: 230
navigation.group: Decisions and output
icon: i-lucide-radar
---

`observability()` gives an Agent Definition one place to attach runtime telemetry.
It can instrument model execution, emit lifecycle events, and provide a finish extension with invocation status, duration, result kind, and structured usage when the Agent Driver reports it.

::warning
`observability()` is deprecated. Agent Invocations now capture metadata-only Trace Events by default, and Agent Finish Hooks receive result kind and normalized usage on `event.invocation`. Supply a Runtime `traceLog` with `onEntry` when the host needs an external sink.
::

## Legacy installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { observability } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    observability({
      onEvent: async event => writeAgentEvent(event),
    }),
  ],
})
```

## Legacy behavior

The Capability emits a `start` event before driver execution.
When `onEvent` is configured, it also emits a `finish` or `error` event after the invocation completes.
`onEvent` is a telemetry sink; sink failures are swallowed so observability cannot change Agent output or hide the original driver failure.

It provides an `observability` finish extension with `{ status, durationMs, resultKind, usage }` for completed invocations and `{ status, durationMs, usage }` for failed invocations.
Agent Evals and the Agent test runner capture this finish extension automatically.

The `observability` finish extension may include the raw Agent Usage Record when the Agent Driver reports usage.
Use `usageTelemetry()` when finish hooks or Channel Delivery finish effects need standalone primitive usage JSON.
Applications own any formatting into text, chat messages, web UI, markdown, notes, billing records, or review comments.

## Eval assertions

Use the built-in scorer or the test callback helpers when an eval should prove the observability path is attached.

```ts [server/agents/support.eval.ts]
import { defineEval, hasCapabilityExtension } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scorers: [
    hasCapabilityExtension('observability', 'status'),
  ],
  async test(t) {
    await t.send('Check order status')
    t.hasCapabilityExtension('observability')
  },
})
```

For custom checks, read `observation.extensions.get('observability')` or `t.capabilityExtension('observability')`.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Supports model instrumentation, lifecycle events, finish extensions, and usage records when the model result reports usage. |
| Harness-backed | Supports lifecycle events, finish extensions, and usage records when the harness reports usage; instrumentation applies only to model-backed execution. |
| Custom-run-backed | Supports lifecycle events, finish extensions, and usage records when the custom result reports usage. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `instrumentation` | `AgentModelExecutionInstrumentation` | none | Model and call-settings instrumentation for model-backed drivers. |
| `onEvent` | `(event) => void` | none | Lifecycle event sink for start, finish, and error events. |

## Reference

- [Agent Evals](/docs/agents/evals)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/observability.ts`
