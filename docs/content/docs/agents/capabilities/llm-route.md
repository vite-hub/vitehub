---
title: LLM route
description: Choose one developer-defined route with a Decisions choice, answered by any model or TypeSafe Jev, before the Agent Driver runs.
navigation.title: LLM route
navigation.order: 270
navigation.group: Capabilities
icon: i-lucide-route
---

`llmRoute()` chooses one developer-defined route before the Agent Driver runs.
It adds no model-facing tool. It records the chosen route as an Invocation context value and does not apply route effects by itself.
The decision is one [Decisions](/docs/decisions) group with `infer: true`. The Agent model answers it, or the `model` you pass, or TypeSafe Jev when you set `gateway`. No Server Primitive is involved.

## Configure routing

Define stable choice keys with short descriptions.
Later code reads the recorded value and decides how to use the route.

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

The Agent model decides. Pass `model` to use a smaller one, or `gateway: vercel()` from `vite-hub/gateways` to ask TypeSafe Jev.

## How routing works

`llmRoute()` runs in the input phase, before the Agent Driver.

1. It reads the latest user text: the string `prompt`, or else the text of the latest user message.
2. It asks which choice fits the text best. See [Decisions](#decisions).
3. It stores the decision as the Invocation context value `llm-route` (or your `id`) and provides it as a finish extension under the same id.

A second writer for the same context value fails early.
`history: true` includes the last 10 messages. A number includes that many messages.

## Decisions

The choices become the options of one Decisions group with `multiple: false` and `infer: true`: the key is the label and the choice text is the description. The text does not have to name a choice. The model infers it.

With a single choice, the Capability records it locally with confidence `1` and probability `1`, and sends no request.
With 2 to 255 choices, it sends one request. The text is the Invocation `data` as JSON when a caller sets it. Otherwise it is the latest user text, after the recent history when `history` is set. The decision reads the last 16,000 bytes.

Who answers:

- `model`, or the Agent model by default, through [`askWithModel()`](/docs/agents/ai-gateways#ask-with-any-model).
- TypeSafe Jev when you set `gateway`, such as `vercel()` or `cloudflare()`. An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent has no Agent model, so it asks Jev through `typesafe()`, which reads `TYPESAFE_API_KEY`.

The decision has `choice`, `confidence`, and `probabilities`, a map from choice key to probability. Jev gives a probability for every choice. A chat model gives one answer and how sure it is, and the other choices share the rest.

To route your own text outside an Agent, use [`defineChoices()`](/docs/decisions/server-api) with the same kind of group.

## Requirements

- At least one choice.
- Choice keys must be stable identifiers: a letter first, then letters, digits, `-`, `_`, or `.`.
- With two or more choices, a model or a gateway. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents do not expose an Agent model to Capabilities, so set `model` or `gateway`.
- For Jev: the `advocaat` package and the key of the gateway (`TYPESAFE_API_KEY` for `typesafe()`, `AI_GATEWAY_API_KEY` for `vercel()`).

## Security and approval

`llmRoute()` adds no model-facing tool, so the Agent gets no new authority. It has no `policy` option.
It does not attach, remove, or grant Capabilities. Code that acts on the route must read the decision and apply its own checks.

The end user controls the routed text, so the user can influence the choice. Do not use a route as access control.
The Capability sends the latest user text, the choice descriptions, and the optional history to the configured model provider or to TypeSafe Jev.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model, `model`, or Jev with `gateway`. Records the route before model execution. |
| Provider-backed | Requires `model` or `gateway`. Records the route before provider execution. |
| Custom-run-backed | Requires `model` or `gateway`. Records the route before `driver.run`; custom code decides how to use it. |
| Ask-backed | Jev through `typesafe()` by default, or `model` or `gateway`. A `driver.ask` function can read the decision from Invocation context. |

## Verify routing

1. Run one invocation and read the finish extension or context value for `llm-route` (or your `id`).
2. Confirm that the value has `choice`, `confidence`, and `probabilities`.
3. If you wrap the model, add a test where the model returns a choice outside the map. Confirm that the invocation fails.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `choices` | `Record<string, string \| { label?: string; description?: string }>` | required | Developer-defined route choices. The description falls back to `label`, then the key. |
| `history` | `boolean \| number` | `false` | Include recent messages in the decision. `true` uses the last 10. |
| `gateway` | `AiGateway` | none, or `typesafe()` for ask Driver Agents | Ask TypeSafe Jev through this gateway instead of a model. Ignored when `model` is set. |
| `id` | `string` | `"llm-route"` | Capability id, Invocation context key, and finish extension key. |
| `model` | `AgentModelResolver` | Agent model | Model that answers the decision. |
| `prompt` | `string` | none | Text placed before the generated decision task. |

## Related pages

- [llmGate()](/docs/agents/capabilities/llm-gate)
- [Agent Invocations](/docs/agents/invocations)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Official Capabilities](/docs/agents/capabilities/official)
