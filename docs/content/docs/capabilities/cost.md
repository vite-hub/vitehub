---
title: Cost
description: Enrich Agent Usage Records with exact, display-ready USD cost.
navigation.title: Cost
navigation.order: 230
navigation.group: Decisions and output
icon: i-lucide-coins
---

Add `cost()` when an application needs exact USD for arithmetic and a ready-to-render value for display. The Capability enriches the Agent Usage Record before Agent Finish Hooks run and before streamed usage is emitted to clients; raw usage capture works without it.

## Add cost

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { cost } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'zai/glm-5v-turbo' },
  capabilities: [
    cost(),
  ],
})
```

By default, `cost()` prices regular input, cache-read, cache-write, and output tokens from Vercel AI Gateway's public model catalog. ViteHub uses exact decimal arithmetic, caches successful catalog responses for five minutes, and bounds each request to ten seconds.

Pricing is best-effort. A missing model match, unavailable catalog, timeout, invalid price, or pricing callback error leaves the usage record and successful Agent Invocation unchanged. A cost already reported by the provider remains authoritative.

## Read the enriched record

Finish Hooks read the canonical record from `event.invocation.usage`. Use `cost.usd` for arithmetic or persistence and `cost.display` for UI; consumers do not need to format the value themselves. The Capability's typed `cost` finish extension returns the same record.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { cost } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'zai/glm-5v-turbo' },
  capabilities: [cost()],
  hooks: {
    'agent:finish'(event) {
      const usageCost = event.invocation.usage?.cost
      if (!usageCost) return

      console.log(usageCost.usd)
      console.log(usageCost.display)
    },
  },
})
```

```txt [Output]
0.00125
~$0.00125
```

The canonical record keeps the full model identifier and Gateway transport separate, preserves exact USD for arithmetic, and includes a ready-to-render display value.

```ts
{
  model: 'zai/glm-5v-turbo',
  transport: 'gateway',
  usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
  cost: {
    usd: '0.00125',
    display: '~$0.00125',
    estimated: true,
    source: 'vercel-ai-gateway',
  },
}
```

For streams, ViteHub waits to resolve pricing until the usage record becomes available during consumption, then enriches it before client emission and Finish Hooks.

## Provide application pricing

Pass `pricing` when the application owns its catalog or provider mapping. Return exact USD as a decimal string; ViteHub derives the display value.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { cost, type AgentUsagePricing } from '@vite-hub/agent/capabilities'

const pricing: AgentUsagePricing = ({ model }) => {
  if (model !== 'internal/support-model') return

  return {
    usd: '0.00125',
    estimated: true,
    source: 'custom',
  }
}

export default defineAgent({
  driver: { model: 'internal/support-model' },
  capabilities: [cost({ pricing })],
})
```

Return `undefined` when pricing is unavailable. Custom pricing receives the model, response metadata, Agent Run metadata, and token usage, and can return a provider quote or a calculation from an application-owned decimal library. Keep it deterministic for those inputs because ViteHub may call it while a stream is consumed.

Import `vercelAiGatewayPricing()` when application-owned work adds usage after the Capability runs and must reprice the record with the same catalog behavior.

```ts
import { vercelAiGatewayPricing } from '@vite-hub/agent/capabilities'

const pricing = vercelAiGatewayPricing()
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | `AgentUsagePricing` | Vercel AI Gateway catalog pricing | Resolves a cost from the model, response metadata, Agent Run metadata, and token usage. |

## Verify it

Invoke the Agent with a model that reports token usage. Confirm that `event.invocation.usage` is present without the Capability, then install `cost()` and confirm a matched model adds `cost`. Test missing and failing pricing callbacks too: both must preserve the successful Agent Invocation and raw usage.

## Related

- [Agent Invocations](/docs/concepts/agent-invocations)
- [Runtime events](/docs/reference/runtime-events)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
