---
title: LLM route
description: Let a model pick one of your routes, such as billing or technical, before the Agent runs.
navigation.title: LLM route
navigation.order: 270
navigation.group: Capabilities
icon: i-lucide-route
---

`llmRoute()` picks one of your routes before the Agent Driver starts and records it in the Invocation (one Agent run) context. Your code acts on it. The decision is one AI SDK model call, or TypeSafe Jev for an [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent. It adds no model tool and uses no Server Primitive.

## Configure routing

Define stable choice keys with short descriptions.
Later code reads the recorded value and acts on it.

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

In the input phase, before the Driver:

1. It reads the string `prompt`, else the latest user message text.
2. It builds a prompt from your `prompt`, the choices, recent history (with `history`), and the user text.
3. It asks the model for `choice`, with optional `confidence` (0 to 1) and `reason`.
4. It rejects a `choice` that is not one of your keys.
5. It stores the decision as context value `llm-route` (or your `id`) and as a finish extension (data attached to the finished run) with the same id. A second Capability writing that value fails early.

`history: true` includes the last 10 messages; a number includes that many.

## Jev decisions

For an ask Driver Agent without `model`:

- One choice is recorded locally with confidence and probability `1`, with no credentials or Jev request. The main ask Driver still needs its own credentials.
- 2 to 255 choices make one Jev `ask.choice()` question. The state is the run's `data` when set, else `{ request, history? }` from the user text and `history`.

- The decision has `choice`, `confidence`, and `probabilities` (choice key to probability), but no `reason`.

- The request goes through the `gateway` option: an [AI gateway](/docs/agents/ai-gateways) such as `cloudflare()`, or `typesafe()`, which reads `TYPESAFE_API_KEY`.

## Requirements

- At least one choice.
- Choice keys: a letter, then letters, digits, `-`, `_`, or `.`.
- A model. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents give Capabilities none, so set `model`, or the run fails with "requires a model option or an agent model".
- For Jev with two or more choices, the `advocaat` package and the gateway key (`TYPESAFE_API_KEY` for `typesafe()`). See [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver).

## Security and approval

There is no model tool, new authority, or `policy` option. It never attaches, removes, or grants Capabilities, so code acting on the route does its own checks.

> [!WARNING]
> Users write the routed text and can steer the choice. Never use a route as access control.

It sends the user text, choice descriptions, and optional history to the model provider or TypeSafe Jev.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model or `model`. |
| Provider-backed | Requires `model`. Records before the provider runs. |
| Custom-run-backed | Requires `model`. Records before `driver.run`, which decides how to use it. |
| Ask-backed | Without `model`, records one choice locally or asks Jev one `ask.choice()` with 2 to 255 choices. `driver.ask` can read the decision from context. |

## Verify routing

1. Run once and read the `llm-route` (or `id`) finish extension or context value.
2. It has `choice`. Model decisions can add `confidence` and `reason`; Jev decisions have `confidence` and `probabilities`.
3. When you wrap the model, test that a choice outside the map fails the run.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `choices` | `Record<string, string \| { label?: string; description?: string }>` | required | Route choices. Description falls back to `label`, then the key. |
| `history` | `boolean \| number` | `false` | Include recent messages. `true` uses 10. |
| `id` | `string` | `"llm-route"` | Capability id, Invocation context key, and finish extension key. |
| `model` | `AgentModelResolver` | Agent model, or Jev for ask Driver Agents | Model used for the decision. |
| `prompt` | `string` | none | Text before the decision task. |

## Related pages

- [llmGate()](/docs/agents/capabilities/llm-gate)
- [Agent Invocations](/docs/agents/invocations)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Official Capabilities](/docs/agents/capabilities/official)
