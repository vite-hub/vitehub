---
title: LLM route
description: Let a model or TypeSafe Jev pick one of your routes before your Agent runs.
navigation.title: LLM route
navigation.order: 270
navigation.group: Capabilities
icon: i-lucide-route
---

`llmRoute()` picks one of your routes before the Agent Driver runs. It records the route in Invocation context (values kept for one Agent run). Later code decides what to do with it. It adds no model tool and uses no Server Primitive. The decision is one [Decisions](/docs/decisions) group with `infer: true`. The Agent model answers it, or your `model`, or TypeSafe Jev when you set `gateway`.

## Configure routing

Define stable choice keys with short descriptions.
Later code reads the recorded value and acts on it.

```ts [server/agents/support.ts] fragment
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

In the input phase, before the Driver:

1. It reads the string `prompt`, else the latest user message text.
2. It asks which choice fits the text best. See [Decisions](#decisions).
3. It stores the decision as context value `llm-route`, or your `id`, and as a finish extension under the same id.

`history: true` includes the last 10 messages; a number includes that many.

## Decisions

Each choice is an option in one Decisions group with `multiple: false` and `infer: true`. Its key is the label, and its text is the description. The model infers a choice even when the request does not name one.

With a single choice, the Capability records it locally with confidence `1` and probability `1`, and sends no request.
With 2 to 255 choices, it sends one request. The text is the run's `data` as JSON when set, else the latest user text with recent `history` before it. It reads up to the last 16,000 bytes of JSON-encoded UTF-8 text, at a code point boundary. Jev leaves room for the choices and question within its 30,000-byte input limit. If these alone cannot fit, use fewer or shorter choices, or set `model`.

Who answers:

- `model`, or the Agent model by default, through [`askWithModel()`](/docs/agents/ai-gateways#ask-with-any-model).
- TypeSafe Jev when you set `gateway`, such as `vercel()` or `cloudflare()`. An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent has no Agent model, so it asks Jev through `typesafe()`, which reads `TYPESAFE_API_KEY`.

The decision has `choice`, `confidence`, and `probabilities`, a map from choice key to probability. Jev gives a probability for every choice. A chat model gives one answer and how sure it is, and the other choices share the rest.

To route your own text outside an Agent, use [`defineChoices()`](/docs/decisions/server-api) with the same kind of group.

## Requirements

- At least one choice.
- Choice keys: a letter, then letters, digits, `-`, `_`, or `.`.
- With two or more choices, a model or a gateway. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents give Capabilities no model, so set `model` or `gateway`.
- For Jev: the `advocaat` package and the key of the gateway (`TYPESAFE_API_KEY` for `typesafe()`, `AI_GATEWAY_API_KEY` for `vercel()`).

## Security and approval

There is no model tool, new authority, or `policy` option. It never attaches, removes, or grants Capabilities, so code acting on the route does its own checks.

> [!WARNING]
> Users write the routed text and can steer the choice. Never use a route as access control.

It sends the user text, choice descriptions, and optional history to the model provider or TypeSafe Jev.

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
