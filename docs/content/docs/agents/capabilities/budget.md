---
title: Budget
description: Bound Agent Invocation tokens and estimated model cost with one inspectable policy.
navigation.title: Budget
navigation.order: 324
navigation.group: Capabilities
icon: i-lucide-wallet-cards
---

`budget()` gives one Agent Invocation a token and cost policy. It composes with `usage()`, Driver capacity, and host admission. The policy is per invocation, so it covers the model calls and repair calls made by that invocation.

## Add a budget

Use the top-level `budget` option when every invocation of the Agent has the same policy:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  budget: {
    tokens: {
      input: 100_000,
      output: 20_000,
      total: 120_000,
    },
    usd: '0.25',
    capacity: {
      concurrency: 2,
      queue: { maxPending: 8 },
    },
  },
})
```

`tokens: 20_000` is shorthand for a total-token limit. `usd` accepts a non-negative number or decimal string. Cost is compared in USD, not in provider credits.

The optional top-level `capacity` field uses the Driver capacity queue and concurrency contract. It is a host admission setting, not a model usage limit. It can be used by itself when an Agent only needs concurrency control. When both `budget.capacity` and `driver.capacity` are set, the budget value is used.

Use the Capability form when the policy is selected at invocation time or when it is part of a reusable Capability list:

```ts
import { budget } from 'vite-hub/agent/capabilities'

const reviewBudget = budget({
  tokens: { total: 80_000 },
  usd: '0.10',
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [reviewBudget],
})
```

The top-level option is the usual choice. When it contains `tokens` or `usd`, ViteHub turns it into the same `budget` Capability internally, so inspection and finish extensions have one contract. A capacity-only top-level option configures the Driver admission queue and does not install a `budget` Capability or a `budget` finish extension.

## Inspect the policy

Run the Agent inspection command while the Vite development server is running:

```bash
vitehub agent info --agent support --json
```

For a token or USD policy, the JSON `capabilities` list contains an entry with `id: "budget"` and its configured `metadata`, including the policy kind and mode. Inspection sanitizes secret-shaped keys, so a `tokens` metadata value can appear as `[redacted]`; treat the Agent source as the authority for its numeric token limits. The `budget` Capability metadata describes configuration only. It does not contain usage from a previous Invocation. Read per-invocation `usage` from the finish extension or persisted Invocation record; the persisted record does not store the computed `exceeded` list, so capture that list in the finish hook or derive it from the limits and recorded usage.

For a capacity-only policy, inspect `config.driver.capacity` instead. The human-readable command reports the active count, admitted limit, hard concurrency maximum, and queue state. That policy can be shared only by Agent Definitions that use the same process-local capacity object; it does not create usage accounting.

## Observe or enforce

The default mode is `observe`. The Invocation completes and the `budget` finish extension reports any exceeded limits. Set `mode: 'enforce'` to fail the Invocation after usage is known:

```ts
export default defineAgent({
  driver: { model: 'gpt-5.6-sol' },
  budget: {
    tokens: 40_000,
    mode: 'enforce',
  },
})
```

Enforcement is a terminal check. It cannot undo a provider request that already ran. The output-token limit is also passed to AI SDK model calls when the provider supports `maxOutputTokens`; cumulative input, output, total-token, and cost checks use the normalized usage record after the call.

Read the result from a finish hook:

```ts
hooks: {
  'agent:finish'(event) {
    const budget = event.extensions.get('budget')
    if (budget?.exceeded.length) {
      console.log(budget.exceeded)
    }
  },
}
```

The snapshot contains the configured `limits`, the normalized `usage` record when one is available, and an `exceeded` list with `inputTokens`, `outputTokens`, `totalTokens`, or `usd` entries.

## Cost sources

Provider-reported cost is used as supplied. When only tokens are reported, the default pricing resolver estimates cost from Models.dev, like [`usage()`](/docs/agents/capabilities/usage). Set `pricing: false` when token limits are enough or outbound catalog access is not wanted. A custom resolver can return `{ usd, estimated, source }` for application-owned rates.

An unknown cost does not count as an exceedance. A hard USD ceiling requires a provider or gateway that reserves and settles spend before a request. `budget()` cannot promise that guarantee from post-call telemetry alone.

## Combine resource limits

Invocation budgets and host resources answer different questions:

| Policy | Scope | Result |
| --- | --- | --- |
| `budget.tokens` and `budget.usd` | One Invocation | Bounds model usage and reports or rejects after usage is known. |
| `budget.capacity` | One host process | Queues Invocations and limits concurrent Drivers from the same top-level policy. |
| Driver `capacity` | One host process | The lower-level capacity option when the policy is configured on a Driver. |
| Babysitter `options.admission` | Babysitter host and time window | Delays new model passes when retained journal usage or host checks cross a threshold. |
| `options.capacity` | Babysitter process host | Admits work using memory, CPU, and fallback concurrency. |

Use all of them when an Agent needs both spend visibility and safe host concurrency. A host admission decision does not cancel active work, and an Invocation budget does not reserve host memory.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Applies `maxOutputTokens` where the AI SDK provider accepts it and checks normalized usage and cost. |
| Provider-backed | Checks the usage record reported by the provider Driver. Provider-specific process limits stay in Driver and Sandbox options. |
| Custom-run-backed | Checks the `usage` or `usageRecord` returned by `driver.run`. |

If a Driver reports no usage, ViteHub cannot compare token or cost limits. The invocation remains successful in `observe` mode.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tokens` | `number \| { input?, output?, total? }` | No token limit | Limits normalized input, output, or total tokens. A number sets `total`. |
| `usd` | `number \| string` | No cost limit | Compares provider-reported or estimated cost in US dollars. Decimal strings preserve exact limits. |
| `capacity` | `AgentDriverCapacityOptions` | Driver setting | Configures process-local admission for the top-level Agent option. It is not a usage limit, and `budget({ capacity })` on the reusable Capability does not configure Driver admission. |
| `mode` | `'observe' \| 'enforce'` | `'observe'` | Reports exceedance or rejects the terminal Invocation after usage is available. |
| `pricing` | `AgentUsagePricing \| false` | Models.dev pricing when `usd` is set; disabled for token-only budgets | Resolves missing cost, or disables estimation. Provider-reported cost remains available when set to `false`. |
| `id` | `string` | `'budget'` | Changes the Capability id when using the reusable Capability form. |
