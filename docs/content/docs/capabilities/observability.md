---
title: Observability
description: Attach lifecycle events, model instrumentation, and eval-visible finish metadata.
navigation.title: Observability
navigation.order: 230
navigation.group: Decisions and output
icon: i-lucide-radar
---

`observability()` gives an Agent Definition one place to attach runtime telemetry.
It can instrument model execution, emit lifecycle events, provide a finish extension with invocation status, duration, and result kind, and enable usage telemetry for the same invocation.

## Installation

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

## What it adds

The Capability emits a `start` event before driver execution.
When `onEvent` is configured, it also emits a `finish` or `error` event after the invocation completes.
`onEvent` is a telemetry sink; sink failures are swallowed so observability cannot change Agent output or hide the original driver failure.

It provides an `observability` finish extension with `{ status, durationMs, resultKind, usage }` for completed invocations and `{ status, durationMs, usage }` for failed invocations.
Agent Evals and the Agent test runner capture this finish extension automatically.

`observability()` enables `usageTelemetry()` by default.
When enabled usage telemetry records usage from the Agent Driver or custom result, `observability.usage` points at the same Agent Usage Record exposed through the `usage-telemetry` finish extension and final `result.usageRecord`.
Use `observability({ usageTelemetry: false })` to opt out.
With that opt-out, a custom `result.usageRecord` can still stay on the result, but `observability.usage` is not populated.

If an Agent also lists `usageTelemetry(...)` in `capabilities`, that explicit configuration wins for the Agent Usage Record itself.
`observability({ usageTelemetry: false })` still suppresses the `observability.usage` alias; omit the opt-out when observability should carry the same usage record in its metadata.

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
| Custom-run-backed | Supports lifecycle events, finish extensions, and usage records when usage telemetry is enabled and the custom result reports usage. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `instrumentation` | `AgentModelExecutionInstrumentation` | none | Model and call-settings instrumentation for model-backed drivers. |
| `onEvent` | `(event) => void` | none | Lifecycle event sink for start, finish, and error events. |
| `usageTelemetry` | `boolean \| UsageTelemetryOptions` | `true` | Enables usage telemetry by default, accepts inline usage telemetry options, or opts out when set to `false`. |

## Reference

- [Agent Evals](/docs/agents/evals)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/observability.ts`
