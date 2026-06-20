---
title: llmGate()
description: Allow or reject an Agent Invocation with a pre-invocation model decision.
navigation.title: llmGate()
navigation.order: 180
icon: i-lucide-shield-alert
---

`llmGate()` adds a pre-invocation model decision that classifies a request into allow or reject categories.
It can stop the Agent Invocation before the main Agent Driver runs.

## What it adds

The Capability asks a model to choose one configured allow or reject category.
It records the decision as an Agent Invocation Context Value, exposes it as a finish extension, and throws `LlmGateRejectedError` when the selected category is rejected.

## Minimum attach example

Define allow and reject categories with stable keys.
Use the message option when the host should return a product-specific rejection message.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { llmGate } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    llmGate({
      allow: {
        support: 'Support request the Agent can answer.',
      },
      reject: {
        unrelated: 'Request unrelated to support.',
      },
    }),
  ],
})
```

## Runtime behavior

`llmGate()` runs during the input phase.
It resolves a model, renders a classifier prompt from the latest user text and configured categories, validates the structured output, and stores the decision in invocation context.

When the decision rejects the request, ViteHub throws `LlmGateRejectedError` with status code `403`.

## Requirements

`llmGate()` requires at least one allow category and one reject category.
Category keys must be stable identifiers.

The Capability requires either an explicit model option or an Agent model resolver available to Capabilities.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Runs the pre-invocation gate before model execution. |
| Harness-backed | Runs the pre-invocation gate before harness execution when a model resolver is available. |
| Custom-run-backed | Runs before `driver.run`; rejected requests do not reach custom code. |

## Inspect and verify

Run one allowed and one rejected invocation.
Inspect the context value for `llm-gate` or your custom id, then verify rejected requests stop with `LlmGateRejectedError`.

Check that the gate does not attach, remove, or grant Capabilities.
It records a decision; later behavior must read that decision explicitly.

## Reference

- [llmRoute()](/docs/capabilities/llm-route)
- [rateLimit()](/docs/capabilities/rate-limit)
- Source: `packages/agent/src/capabilities/llm-gate.ts`
