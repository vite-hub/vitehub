---
title: Usage telemetry
description: Expose primitive usage JSON at the end of an Agent Invocation.
navigation.title: Usage telemetry
navigation.order: 215
navigation.group: Decisions and output
icon: i-lucide-gauge
---

`usageTelemetry()` exposes usage as data at the end of an Agent Invocation.
It does not format messages, comments, markdown, web UI, billing notes, or summaries.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { usageTelemetry } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    usageTelemetry(),
  ],
  hooks: {
    'agent:finish'(event) {
      const usage = event.extensions.get('usage-telemetry')
      if (!usage) return
      event.runtime.waitUntil(recordUsage(usage))
    },
  },
})
```

## What it adds

The Capability provides a `usage-telemetry` finish extension when the Agent result contains usage.
Read the same extension in Channel Delivery finish effects with `context.extensions.get("usage-telemetry")`.

The value is a flat `UsageTelemetryRecord` with primitive fields such as:

| Field | Meaning |
| --- | --- |
| `inputTokens`, `outputTokens`, `totalTokens` | Token counts when the provider reports them or ViteHub can derive them. |
| `durationMs`, `timeToFirstTokenMs`, `tokensPerSecond` | Speed metrics when available. |
| `costAmount`, `costCurrency`, `costEstimated`, `costSource` | Cost primitives when a driver or provider reports cost. |
| `modelId`, `modelProvider` | Model identity when available. |
| `responseId`, `responseTimestamp`, `responseFinishReason` | Provider response metadata when available. |
| `runId`, `threadId`, `messageId` | Invocation identifiers from runtime metadata. |

## Runtime behavior

`usageTelemetry()` runs in the finish phase.
It derives the extension from the normalized Agent Usage Record used by Agent results and stream `usage` events, then flattens only primitive values into JSON.

Applications own formatting.
For example, a chat integration can turn the JSON into text, while a billing sink can store the JSON unchanged.

## Requirements

The Agent Driver or output renderer must provide usage data.
If no usage exists, the `usage-telemetry` extension is absent.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Reads token, latency, model, response, and cost fields when the provider reports them. |
| Harness-backed | Reads normalized usage from harness results and streams. |
| Custom-run-backed | Reads `usage`, `totalUsage`, or `usageRecord` from custom results. |

## Inspect and verify

Attach `usageTelemetry()`, run the Agent once, and inspect `event.extensions.get("usage-telemetry")` in an `agent:finish` hook.
For delivery effects, inspect `context.extensions.get("usage-telemetry")`.

## Reference

- [Agent invocations](/docs/agents/invocations)
- [Runtime events](/docs/reference/runtime-events)
- [observability()](/docs/capabilities/observability)
- Source: `packages/agent/src/capabilities/usage-telemetry.ts`
