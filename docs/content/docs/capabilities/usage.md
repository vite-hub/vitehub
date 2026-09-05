---
title: Usage
description: Request provider usage metadata and expose normalized tokens and cost at finish.
navigation.title: Usage
navigation.order: 225
navigation.group: Decisions and output
icon: i-lucide-chart-no-axes-column
---

Add `usage()` to request complete provider usage metadata and expose ViteHub's normalized Agent Usage Record as a typed Finish Extension.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
})
```

For OpenRouter calls, the Capability sets `providerOptions.openrouter.usage.include` to `true`. Existing provider options and OpenRouter usage settings are preserved.

## Read usage and cost

The typed `usage` Finish Extension returns the same normalized record available at `event.invocation.usage`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
  hooks: {
    'agent:finish'(event) {
      const record = event.extensions.get('usage')
      console.log(record?.usage?.totalTokens)
      console.log(record?.cost?.usd)
    },
  },
})
```

The record can contain normalized token usage, model, execution provider, transport, latency, and cost. Fields remain optional when the provider does not report enough data and ViteHub cannot derive them safely.

Provider-reported cost remains authoritative. When a provider reports tokens without cost, `usage()` uses the public [Models.dev](https://models.dev) catalog to estimate regular input, cache-read, cache-write, context-tier, and output token cost. ViteHub caches a successful catalog response for one hour and bounds each request to ten seconds.

Pricing is best-effort. A missing provider or model match, unavailable catalog, timeout, invalid rate, or pricing callback error leaves the usage record and successful Agent Invocation unchanged.

```ts
{
  model: 'anthropic/claude-sonnet-4.5',
  provider: 'openrouter',
  usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
  cost: {
    usd: '0.00375',
    display: '~$0.00375',
    estimated: true,
    source: 'models.dev',
  },
}
```

Use `cost.usd` for arithmetic or persistence. Use `cost.display` for UI. For streams, ViteHub resolves pricing when usage becomes available, before it emits usage to clients and before Finish Hooks run.

## Control pricing

Pass `pricing: false` when the application needs tokens without estimated cost.

```ts
capabilities: [usage({ pricing: false })]
```

The Capability exposes whether pricing is configured in `metadata.costSupported`. The Console uses this flag before recorded cost is available. Provider-recorded cost remains available when pricing is disabled.

Pass `pricing` when the application owns its rates or provider mapping. Return exact USD as a decimal string. ViteHub derives the display value.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage, type AgentUsagePricing } from 'vite-hub/agent/capabilities'

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
  capabilities: [usage({ pricing })],
})
```

Custom pricing receives the model, execution provider, transport, response metadata, Agent Run metadata, and token usage. Return `undefined` when pricing is unavailable. Keep the result deterministic for those inputs because ViteHub may call it while a stream is consumed.

Import `modelsDevPricing()` when application-owned work adds usage after the Capability runs and must apply the same catalog behavior.

```ts
import { modelsDevPricing } from 'vite-hub/agent/capabilities'

const pricing = modelsDevPricing()
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | `AgentUsagePricing \| false` | Models.dev pricing | Resolves estimated cost, or disables estimation when set to `false`. |

## Verify it

Invoke the Agent with a model that reports token usage. Confirm that the Finish Extension matches `event.invocation.usage`. If the provider does not report cost, confirm that a matching Models.dev entry adds estimated cost. Also test missing and failing pricing, which must preserve the successful Agent Invocation and raw usage.

## Related

- [Agent Invocations](/docs/concepts/agent-invocations)
- [Runtime events](/docs/reference/runtime-events)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
