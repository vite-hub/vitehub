---
title: Usage
description: See how many tokens each Agent run used and what it cost, when the run finishes.
navigation.title: Usage
navigation.order: 325
navigation.group: Capabilities
icon: i-lucide-chart-no-axes-column
---

`usage()` reports the tokens and cost of each Agent run.
It asks the provider for full usage data and, at the end, gives the Agent Usage Record (usage in one shape for all providers) as a typed `usage` finish extension, data attached to the finished run.

It reads what the provider or Agent Driver reports and estimates missing cost from the public [Models.dev](https://models.dev) catalog. It adds no model tool and uses no Server Primitive. For token or USD limits from the same record, use [`budget()`](/docs/agents/capabilities/budget).

## Configure usage

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
})
```

Read it in a finish hook. The extension equals `event.invocation.usage`.

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

On AI SDK calls from a model-backed Driver, the Capability sets `providerOptions.openrouter.usage.include` to `true`, keeping your other provider options and OpenRouter usage settings.

At the end, it reads `event.invocation.usage`: token usage, model, execution provider, transport, latency, and cost. A field stays empty when the provider reports too little to calculate it safely.

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

Use `cost.usd` for math and storage, and `cost.display` in the UI. For streams, the price is calculated when usage arrives, before clients get usage and before finish hooks run.

The extension is ready without a finish hook. The Capability id is always `usage`.

## Control pricing

A provider-reported cost is used as is. For tokens without cost, Models.dev estimates regular input, cache read, cache write, context tier, and output. Successful catalog responses are cached for one hour; each request times out after ten seconds.

Pricing is best effort. A missing provider or model, an unavailable catalog, a timeout, an invalid rate, or a pricing callback error never changes the record or fails the run.

`pricing: false` gives tokens without estimates; provider-reported cost stays. `metadata.pricing` shows whether pricing is on, which the Console reads before the cost is recorded.

```ts
capabilities: [usage({ pricing: false })]
```

For your own rates or provider mapping, pass a `pricing` function that returns the exact USD amount as a decimal string; ViteHub derives the display value.

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

It gets the model, execution provider, transport, response metadata, Agent Run metadata, and token usage. Return `undefined` for no price. It must be deterministic, since it can run while a stream is read.

When your code adds usage later, `modelsDevPricing()` uses the same prices. Options: `catalogUrl` (default `https://models.dev/api.json`), `maxAge` (milliseconds, default one hour), `timeout` (milliseconds, default `10000`), and a custom `fetch`.

```ts
import { modelsDevPricing } from 'vite-hub/agent/capabilities'

const pricing = modelsDevPricing()
```

## Requirements

- The provider or Driver reports token usage. Otherwise the record stays empty and no cost is estimated.
- Models.dev pricing needs network access to the catalog, or it is skipped.

## Security and approval

There is no model tool, `policy` option, or new authority.
Default pricing downloads the public Models.dev catalog without sending prompts, output, or usage. `pricing: false` or your own function stops the request.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Requests OpenRouter usage on AI SDK calls, then normalizes and prices it. |
| Provider-backed | Normalizes and prices the Driver's usage. The OpenRouter setting does not apply. |
| Custom-run-backed | Normalizes and prices the `driver.run` usage. |

## Verify usage

1. With a model that reports tokens, the extension equals `event.invocation.usage`.
2. Without provider cost, a matching Models.dev entry adds a cost with `source: 'models.dev'`.
3. With missing or failing pricing, the run still succeeds with raw usage.
4. `vitehub agent info --agent support --json` shows `pricing: true` in `usage` metadata, or `false` with `pricing: false`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | `AgentUsagePricing \| false` | `modelsDevPricing()` | Estimates cost, or `false` to turn estimates off. |

## Related pages

- [Agent Invocations](/docs/agents/invocations)
- [Runtime events](/docs/reference/runtime-events)
- [Custom Capabilities](/docs/agents/capabilities/custom)
- [Official Capabilities](/docs/agents/capabilities/official)
