---
title: Budget
description: Limit the tokens and the model cost of each Agent run with one policy you can inspect.
navigation.title: Budget
navigation.order: 324
navigation.group: Capabilities
icon: i-lucide-wallet-cards
---

`budget()` limits the tokens and cost of one Invocation (one Agent run), including its model and repair calls. It works with `usage()`, Driver capacity, and host admission.

## Add a budget

Use the top-level `budget` option when every run has the same limits:

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

- `tokens: 20_000` limits total tokens.
- `usd` takes a non-negative number or decimal string. Cost is in USD, not provider credits.
- Optional `capacity` sets how many runs the host starts at once and how many queue, with the Driver capacity rules. It is not a usage limit, and works alone for concurrency control. If both `budget.capacity` and `driver.capacity` are set, the budget value wins.

Use the Capability form to choose limits per run or to reuse a Capability list:

```ts
import { defineAgent } from 'vite-hub/agent'
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

Most Agents use the top-level option. With `tokens` or `usd`, ViteHub turns it into the same `budget` Capability, so inspection and finish extensions match. With only `capacity`, it sets the Driver admission queue and adds no `budget` Capability or finish extension.

## Inspect the policy

With the Vite development server running, inspect the Agent:

```bash
vitehub agent info --agent support --json
```

For a token or USD policy, the JSON `capabilities` list has an `id: "budget"` entry whose `metadata` shows the configuration, including policy kind and mode. It shows no usage from earlier runs.

> [!NOTE]
> Inspection hides secret-shaped keys, so `tokens` can show as `[redacted]`. Read token limits in the Agent source.

Read a run's `usage` from the finish extension or the saved Invocation record. The record does not store the `exceeded` list, so save it in the finish hook or compute it from the limits and usage.

For a `capacity`-only policy, inspect `config.driver.capacity`. The text output shows the active count, admitted limit, hard concurrency maximum, and queue state. Agent Definitions share this policy only through the same capacity object in one process. It counts no usage.

## Observe or enforce

In the default `observe` mode, the run completes and the `budget` finish extension reports each exceeded limit. Set `mode: 'enforce'` to fail the run once usage is known:

```ts
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'gpt-5.6-sol' },
  budget: {
    tokens: 40_000,
    mode: 'enforce',
  },
})
```

> [!WARNING]
> `enforce` checks at the end. It cannot undo a provider request that already ran.

If the provider supports `maxOutputTokens`, AI SDK model calls also get the output-token limit. Input, output, total-token, and cost checks use the normalized usage record after the call.

Read the result from a finish hook:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'gpt-5.6-sol' },
  budget: { tokens: 40_000 },
  hooks: {
    'agent:finish'(event) {
      const budget = event.extensions.get('budget')
      if (budget?.exceeded.length) {
        console.log(budget.exceeded)
      }
    },
  },
})
```

The snapshot has the configured `limits`, the normalized `usage` record when available, and an `exceeded` list of `inputTokens`, `outputTokens`, `totalTokens`, or `usd` entries.

## Cost sources

- A provider-reported cost is used as is.
- With only tokens, the default resolver estimates cost from Models.dev, like [`usage()`](/docs/agents/capabilities/usage).
- A custom resolver can return `{ usd, estimated, source }` for your own prices.

Set `pricing: false` when token limits are enough or you want no Models.dev calls.

> [!WARNING]
> An unknown cost never exceeds the limit. A hard USD limit needs a provider or gateway that reserves spend before the request. `budget()` sees usage only after the call.

## Combine resource limits

A budget limits one run. Host limits protect the machine:

| Policy | Scope | Result |
| --- | --- | --- |
| `budget.tokens` and `budget.usd` | One Invocation | Limits model usage. Reports or rejects once usage is known. |
| `budget.capacity` | One host process | Queues Invocations and limits concurrent Drivers. |
| Driver `capacity` | One host process | The same limit, set on a Driver. |
| Babysitter `options.admission` | Babysitter host and time window | Delays new model passes when retained journal usage or host checks cross a threshold. |
| `options.capacity` | Babysitter process host | Admits work using memory, CPU, and fallback concurrency. |

Combine them to see spend and keep the host safe. Host admission does not cancel running work, and a budget reserves no host memory.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Applies `maxOutputTokens` where supported, and checks usage and cost. |
| Provider-backed | Checks the Driver's usage record. Process limits stay in Driver and Sandbox options. |
| Custom-run-backed | Checks the `usage` or `usageRecord` returned by `driver.run`. |

If a Driver reports no usage, limits are not checked. In `observe` mode the run still succeeds.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tokens` | `number \| { input?, output?, total? }` | No token limit | Limits normalized input, output, or total tokens. A number sets `total`. |
| `usd` | `number \| string` | No cost limit | Compares provider-reported or estimated cost in US dollars. Decimal strings preserve exact limits. |
| `capacity` | `AgentDriverCapacityOptions` | Driver setting | Process-local admission, top-level option only. Not a usage limit. `budget({ capacity })` does not set Driver admission. |
| `mode` | `'observe' \| 'enforce'` | `'observe'` | Report or reject once usage is known. |
| `pricing` | `AgentUsagePricing \| false` | Models.dev pricing when `usd` is set; disabled for token-only budgets | Fills missing cost. `false` stops estimates but keeps provider-reported cost. |
| `id` | `string` | `'budget'` | Capability id in the reusable form. |
