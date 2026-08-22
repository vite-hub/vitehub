---
title: LLM route
description: Choose one developer-defined route before the main Agent Invocation runs.
navigation.title: LLM route
navigation.order: 170
navigation.group: Decisions and output
icon: i-lucide-route
---

`llmRoute()` adds a pre-invocation model decision that chooses one developer-defined route.
It records the chosen route as an Agent Invocation Context Value and does not apply route effects by itself.

The Capability asks a model to select exactly one configured choice.
It can include recent conversation history, records the decision under a stable id, and exposes the decision as a finish extension.

## Configure routing

Define stable choice keys with short descriptions.
Later callbacks can read the recorded context value and decide how to use the route.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { llmRoute } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    llmRoute({
      choices: {
        billing: 'Billing and invoice requests.',
        technical: 'Technical troubleshooting requests.',
      },
    }),
  ],
})
```

## How routing works

`llmRoute()` runs during the input phase before the main Agent Driver.
It resolves a model, renders a decision prompt from the latest user text and configured choices, validates the structured output, and stores the result in invocation context.

The default context id is `llm-route`.
Duplicate writers for the same invocation context value fail early.

## Requirements

`llmRoute()` requires at least one choice.
Choice keys must be stable identifiers.

The Capability requires either an explicit model option or an Agent model resolver available to Capabilities.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Runs the pre-invocation decision and records the route before model execution. |
| Provider-backed | Runs the pre-invocation decision before provider execution when a model resolver is available. |
| Custom-run-backed | Records the decision before `driver.run`; custom code decides how to use it. |

## Verify routing

Run one invocation and inspect the context value for `llm-route` or your custom id.
Confirm that the value includes `choice`. It may also include confidence or a reason.

Add a test case for an invalid model response if you provide a custom model wrapper.
Confirm that the Capability rejects choices outside the configured map.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `choices` | `Record<string, string \| { label?: string; description?: string }>` | required | Developer-defined route choices. |
| `history` | `boolean \| number` | `false` | Include recent conversation history in the classifier prompt. |
| `id` | `string` | `"llm-route"` | Capability id and invocation context key. |
| `model` | `AgentModelResolver` | Agent model | Model used for the pre-invocation decision. |
| `prompt` | `string` | generated | Additional classifier prompt text. |

## Related pages

- [llmGate()](/docs/capabilities/llm-gate)
- [Agent invocations](/docs/agents/invocations)
