---
title: Rate limit
description: Check or consume a trusted invocation budget before the Agent runs.
navigation.title: Rate limit
navigation.order: 190
navigation.group: Decisions and output
icon: i-lucide-gauge
---

`rateLimit()` adds a pre-invocation budget check.
It uses trusted invocation identity, records a typed decision, and can reject before the main Agent Invocation proceeds.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability checks or consumes one budget unit for the configured identity, scope, limit, and window.
It records the Rate Limit Decision as an Agent Invocation Context Value and exposes it as a finish extension.

## Configuration

Use the memory store only for local development, tests, or single-process hosts.
Hosted runtimes require an explicit Rate Limit Store.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { rateLimit } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    rateLimit({
      limit: 20,
      store: 'memory',
      window: '1m',
    }),
  ],
})
```

## Runtime behavior

`rateLimit()` runs during the input phase.
It resolves identity from the Agent Invoker by default, falls back through run metadata or trusted IP headers when configured, then calls the store's `check()` or `consume()` method.

Rejected requests throw `RateLimitRejectedError` with status code `429` and retry headers.

## Requirements

`rateLimit()` requires a positive integer limit and a window such as `60s`, `15m`, or `1h`.
Hosted runtimes require an explicit store with `check()` and `consume()` methods.

Trusted IP identity requires configured trusted headers.
Use Agent Invoker identity when the host can provide it.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Runs before model execution and records the decision. |
| Harness-backed | Runs before harness execution and records the decision. |
| Custom-run-backed | Runs before `driver.run`; rejected requests do not reach custom code. |

## Inspect and verify

Run repeated invocations with the same identity until the budget is exhausted.
Inspect the Rate Limit Decision for limit, used, remaining, reset time, identity source, and scope.

On a hosted runtime, run without an explicit store during development or preview.
The Capability should fail with a store requirement instead of using process memory.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | `number \| function` | required | Maximum allowed count for the window. |
| `window` | ``${number}ms\|s\|m\|h\|d`` | required | Fixed window duration. |
| `action` | `"check" \| "consume"` | `"consume"` | Store operation. |
| `id` | `string` | `"rate-limit"` | Capability id and invocation context key. |
| `identity` | `"auto" \| "invoker" \| "ip" \| "run" \| function` | `"auto"` | Identity used to build the rate-limit key. |
| `scope` | `string \| function` | capability id | Extra key partition. |
| `store` | `RateLimitStore \| "memory" \| function` | local memory outside hosted runtimes | Store implementation. |
| `trustedIpHeaders` | `string[]` | none | Request headers trusted for `identity: "ip"` or auto IP fallback. |
| `message` | `string \| function` | default rejection message | Error message when the limit rejects. |
| `onDecision` | `function` | none | Callback after every rate-limit decision. |
| `onAllowed` | `function` | none | Callback after allowed decisions. |
| `onRejected` | `function` | none | Callback after rejected decisions. |

## Reference

- [Agent invocations](/docs/agents/invocations)
- [llmGate()](/docs/capabilities/llm-gate)
- Source: `packages/agent/src/capabilities/rate-limit.ts`
