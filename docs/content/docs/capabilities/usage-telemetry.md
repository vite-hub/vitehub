---
title: usageTelemetry()
description: Normalize Agent Usage Records and attach them to Agent output.
navigation.title: usageTelemetry()
navigation.order: 220
icon: i-lucide-chart-no-axes-column
---

`usageTelemetry()` records Agent Usage from model-backed, harness-backed, or custom results when the result reports usage.
It normalizes usage fields, can estimate cost through a pricing function, and attaches an Agent Usage Record to output.

## What it adds

The Capability wraps compatible streams and output results.
It emits `usage` stream events when a finish chunk contains usage, attaches `usage` and `usageRecord` to final results, and calls an optional `onUsage` callback.

## Minimum attach example

Attach `usageTelemetry()` when an Agent should report usage to application telemetry.
The callback receives a normalized Agent Usage Record.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { usageTelemetry } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    usageTelemetry({
      onUsage: async record => saveAgentUsage(record),
    }),
  ],
})
```

## Runtime behavior

`usageTelemetry()` runs in the output phase.
It reads usage from result objects or finish stream chunks, normalizes token and non-token usage details, and preserves raw usage only when configured.

Pricing functions enrich telemetry only.
Pricing errors do not fail the Agent Invocation.

## Requirements

The Agent Driver or custom result must report usage for the Capability to record anything.
Cost reporting requires a pricing function such as static model pricing or a gateway pricing resolver.

Do not invent exact cost for subscription-backed harness runs.
Preserve provider-reported non-token usage details instead.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Records token-shaped usage when the model result reports it. |
| Harness-backed | Records usage records when the harness reports sessions, actions, quota, wall time, or other usage details. |
| Custom-run-backed | Records usage when custom output includes recognizable usage data. |

## Inspect and verify

Run one invocation and inspect the final result for `usageRecord`.
For streams, inspect emitted `usage` events after finish chunks.

When `onUsage` is configured, assert it receives one normalized record for a completed invocation.

## Reference

- [Agent invocations](/docs/agents/invocations)
- [Official capabilities](/docs/capabilities/official-capabilities)
- Source: `packages/agent/src/capabilities/usage-telemetry.ts`
