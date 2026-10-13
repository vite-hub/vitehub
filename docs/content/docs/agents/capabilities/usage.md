---
title: Usage
description: Request provider usage metadata and expose normalized tokens and cost at finish.
navigation.title: Usage
navigation.order: 325
navigation.group: Capabilities
icon: i-lucide-chart-no-axes-column
---

`usage()` requests complete provider usage metadata and exposes ViteHub's normalized Agent Usage Record as a typed `usage` finish extension.
It adds no model-facing tool. It reads usage metadata that the model provider or Agent Driver reports, and it estimates missing cost from the public [Models.dev](https://models.dev) catalog. No Server Primitive is involved.

## Configure usage

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
})
```

Read the record in a finish hook. The typed `usage` finish extension returns the same normalized record available at `event.invocation.usage`.

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

## How usage works

For the AI SDK model calls of a model-backed Agent Driver, the Capability sets `providerOptions.openrouter.usage.include` to `true`. Existing provider options and OpenRouter usage settings are preserved.

At finish, it reads `event.invocation.usage`. The record can contain normalized token usage, model, execution provider, transport, latency, and cost. Fields remain optional when the provider does not report enough data and ViteHub cannot derive them safely.

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

Use `cost.usd` for arithmetic or persistence. Use `cost.display` for UI. For streams, ViteHub resolves pricing when usage becomes available, before it emits usage to clients and before finish hooks run.

The finish extension is resolved eagerly, so it does not need a finish hook. The Capability id is always `usage`.

## Control pricing

Provider-reported cost remains authoritative. When a provider reports tokens without cost, `usage()` uses the Models.dev catalog to estimate regular input, cache-read, cache-write, context-tier, and output token cost. ViteHub caches a successful catalog response for one hour and bounds each request to ten seconds.

Pricing is best-effort. A missing provider or model match, unavailable catalog, timeout, invalid rate, or pricing callback error leaves the usage record and successful Agent Invocation unchanged.

Pass `pricing: false` when the application needs tokens without estimated cost.

```ts
capabilities: [usage({ pricing: false })]
```

The Capability exposes whether pricing is configured in `metadata.pricing`. The Console uses this flag before recorded cost is available. Provider-recorded cost remains available when pricing is disabled.

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

`modelsDevPricing()` accepts `catalogUrl` (default `https://models.dev/api.json`), `maxAge` in milliseconds (default one hour), `timeout` in milliseconds (default `10000`), and a custom `fetch`.

## Requirements

- The model provider or Agent Driver must report token usage. Without usage, the record stays empty and no cost is estimated.
- Models.dev pricing needs outbound network access to the catalog URL. Without it, pricing is skipped.

## Security and approval

`usage()` adds no model-facing tool and has no `policy` option. The Agent gets no new authority.
The default pricing fetches the public Models.dev catalog. ViteHub sends no prompt, output, or usage data in that request. Use `pricing: false` or custom `pricing` to avoid the outbound request.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Requests OpenRouter usage metadata on AI SDK calls, then normalizes and prices the reported usage. |
| Provider-backed | Normalizes and prices the usage that the provider Driver reports. The OpenRouter call setting does not apply. |
| Custom-run-backed | Normalizes and prices the usage that the `driver.run` result reports. |

## Verify usage

1. Invoke the Agent with a model that reports token usage. Confirm that the finish extension matches `event.invocation.usage`.
2. If the provider does not report cost, confirm that a matching Models.dev entry adds estimated cost with `source: 'models.dev'`.
3. Test missing and failing pricing. Both must preserve the successful Agent Invocation and raw usage.
4. Run `vitehub agent info --agent support --json` and confirm that the `usage` Capability metadata has `pricing: true`, or `false` with `pricing: false`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | `AgentUsagePricing \| false` | `modelsDevPricing()` | Resolves estimated cost, or disables estimation when set to `false`. |

## Related pages

- [Agent Invocations](/docs/agents/invocations)
- [Runtime events](/docs/reference/runtime-events)
- [Custom Capabilities](/docs/agents/capabilities/custom)
- [Official Capabilities](/docs/agents/capabilities/official)
