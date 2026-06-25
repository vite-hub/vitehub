---
title: Observability
description: Attach lifecycle events, model instrumentation, and eval-visible finish metadata.
navigation.title: Observability
navigation.order: 230
navigation.group: Decisions and output
icon: i-lucide-radar
---

`observability()` gives an Agent Definition one place to attach runtime telemetry.
It can instrument model execution, emit lifecycle events, and provide a finish extension with invocation status, duration, and result kind.

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

It provides an `observability` finish extension with `{ status, durationMs, resultKind }` for completed invocations and `{ status, durationMs }` for failed invocations.
Agent Evals and the Agent test runner capture this finish extension automatically.

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
| Model-backed | Supports model instrumentation, lifecycle events, and finish extensions. |
| Harness-backed | Supports lifecycle events and finish extensions; instrumentation applies only to model-backed execution. |
| Custom-run-backed | Supports lifecycle events and finish extensions around the custom result. |

## Reference

- [Agent Evals](/docs/agents/evals)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/observability.ts`
