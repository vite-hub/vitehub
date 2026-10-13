---
title: LLM route
description: Choose one developer-defined route with a model decision before the Agent Driver runs.
navigation.title: LLM route
navigation.order: 270
navigation.group: Capabilities
icon: i-lucide-route
---

`llmRoute()` chooses one developer-defined route before the Agent Driver runs.
It adds no model-facing tool. It records the chosen route as an Invocation context value and does not apply route effects by itself.
The decision uses one AI SDK model call, or TypeSafe Jev for an [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent. No Server Primitive is involved.

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

## How routing works

`llmRoute()` runs in the input phase, before the Agent Driver.

1. It reads the latest user text: the string `prompt`, or else the text of the latest user message.
2. It builds a decision prompt from your `prompt` text, the choices, the recent history when `history` is set, and the user text.
3. It resolves the model and asks for a structured object with `choice` and optional `confidence` (0 to 1) and `reason`.
4. It rejects a `choice` that is not a configured key.
5. It stores the decision as the Invocation context value `llm-route` (or your `id`) and provides it as a finish extension under the same id.

A second writer for the same context value fails early.
`history: true` includes the last 10 messages. A number includes that many messages.

## Jev decisions

When the Capability has no `model` option, an ask Driver Agent records a single configured choice locally with confidence `1` and probability `1`. This route decision needs no credentials and sends no Jev request. The main ask Driver still needs its configured credentials.

With 2 to 255 choices, the Capability asks TypeSafe Jev one `ask.choice()` question.
The state is the Invocation `data` when a caller sets it. Otherwise it is `{ request, history? }` from the latest user text and the `history` option.

The decision has `choice`, `confidence`, and `probabilities`, a map from choice key to probability. Jev decisions have no `reason`.
Credentials come from the `typesafe` Server Env group, as for the ask Driver.

## Requirements

- At least one choice.
- Choice keys must be stable identifiers: a letter first, then letters, digits, `-`, `_`, or `.`.
- A model. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents do not expose an Agent model to Capabilities, so set `model`. Without a model, the invocation fails with "requires a model option or an agent model".
- For Jev decisions with two or more choices: the `advocaat` package and the `typesafe` Server Env group. See [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver).

## Security and approval

`llmRoute()` adds no model-facing tool, so the Agent gets no new authority. It has no `policy` option.
It does not attach, remove, or grant Capabilities. Code that acts on the route must read the decision and apply its own checks.

The end user controls the routed text, so the user can influence the choice. Do not use a route as access control.
The Capability sends the latest user text, the choice descriptions, and the optional history to the configured model provider or to TypeSafe Jev.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model or `model`. Records the route before model execution. |
| Provider-backed | Requires `model`. Records the route before provider execution. |
| Custom-run-backed | Requires `model`. Records the route before `driver.run`; custom code decides how to use it. |
| Ask-backed | Without `model`, records a single choice locally or asks Jev one `ask.choice()` question with 2 to 255 choices. A `driver.ask` function can read the decision from Invocation context. |

## Verify routing

1. Run one invocation and read the finish extension or context value for `llm-route` (or your `id`).
2. Confirm that the value has `choice`. Model decisions can also have `confidence` and `reason`. Jev decisions have `confidence` and `probabilities`.
3. If you wrap the model, add a test where the model returns a choice outside the map. Confirm that the invocation fails.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `choices` | `Record<string, string \| { label?: string; description?: string }>` | required | Developer-defined route choices. The description falls back to `label`, then the key. |
| `history` | `boolean \| number` | `false` | Include recent messages in the decision. `true` uses the last 10. |
| `id` | `string` | `"llm-route"` | Capability id, Invocation context key, and finish extension key. |
| `model` | `AgentModelResolver` | Agent model, or Jev for ask Driver Agents | Model used for the decision. |
| `prompt` | `string` | none | Text placed before the generated decision task. |

## Related pages

- [llmGate()](/docs/agents/capabilities/llm-gate)
- [Agent Invocations](/docs/agents/invocations)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Official Capabilities](/docs/agents/capabilities/official)
