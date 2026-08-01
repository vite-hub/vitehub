---
title: Usage cost
description: Enrich Agent Usage Records with best-effort monetary cost.
navigation.title: Usage cost
navigation.order: 230
navigation.group: Decisions and output
icon: i-lucide-coins
---

`usageCost()` enriches ViteHub's canonical Agent Usage Record with monetary cost before Agent Finish Hooks run and before streamed usage is emitted to clients. Raw usage capture remains part of the Agent Invocation whether or not you install this Capability.

## Add usage cost

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { usageCost } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    usageCost(),
  ],
})
```

The default pricing callback fetches Vercel AI Gateway's public model catalog. It uses exact decimal arithmetic for regular input, cache-read, cache-write, and output tokens, caches successful catalog responses for five minutes, and bounds each catalog request to ten seconds.

Pricing is best-effort. A missing model match, unavailable catalog, timeout, invalid price, or pricing callback error leaves the usage record and successful Agent Invocation unchanged. A cost already reported by the provider remains authoritative.

Import `vercelAiGatewayPricing()` when application-owned work adds usage after the Capability runs and must reprice the canonical record with the same catalog behavior.

```ts
import { usageCost, vercelAiGatewayPricing } from '@vite-hub/agent/capabilities'

const pricing = vercelAiGatewayPricing()
```

## Read the enriched record

Finish Hooks read the canonical record from `event.invocation.usage`. The Capability also returns that same object from its typed finish extension.

```ts [server/agents/support.ts]
defineAgent({
  driver: { model },
  capabilities: [usageCost()],
  hooks: {
    'agent:finish'(event) {
      const usage = event.invocation.usage
      const enrichedUsage = event.extensions.get('usage-cost')

      console.log(usage?.cost, enrichedUsage?.cost)
    },
  },
})
```

Agent output keeps its existing usage shape. For streams, ViteHub waits to resolve pricing until the usage record becomes available during consumption, then enriches it before client emission and Finish Hooks.

## Provide application pricing

Pass `pricing` when the application owns its catalog or provider mapping. The callback uses ViteHub types and does not require a provider SDK.

```ts [server/agents/support.ts]
import type { AgentUsagePricing } from '@vite-hub/agent/capabilities'

const pricing: AgentUsagePricing = ({ model, usage }) => {
  if (model?.id !== 'internal/support-model') return

  return {
    amount: String((usage.totalTokens ?? 0) / 1_000_000),
    currency: 'USD',
    estimated: true,
    source: 'custom',
  }
}

defineAgent({
  driver: { model },
  capabilities: [usageCost({ pricing })],
})
```

Return `undefined` when pricing is unavailable. Keep the callback deterministic for the supplied model and usage record; ViteHub may call it while a stream is being consumed.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | `AgentUsagePricing` | Vercel AI Gateway catalog pricing | Resolves a cost from the model, response metadata, Agent Run metadata, and token usage. |

## Verify it

Invoke the Agent with a model that reports token usage. Confirm that `event.invocation.usage` is present without the Capability, then install `usageCost()` and confirm a matched model adds `cost`. Test missing and failing pricing callbacks too: both must preserve the successful Agent Invocation and raw usage.

## Related

- [Agent Invocations](/docs/concepts/agent-invocations)
- [Runtime events](/docs/reference/runtime-events)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
