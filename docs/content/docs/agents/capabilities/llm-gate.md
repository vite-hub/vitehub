---
title: LLM gate
description: Let a model allow or reject a request before your Agent runs.
navigation.title: LLM gate
navigation.order: 280
navigation.group: Capabilities
icon: i-lucide-shield-alert
---

`llmGate()` stops off-topic requests before the Agent Driver runs. A model puts the request in one allow or reject category. A reject stops the Invocation (one Agent run) with `LLM_GATE_REJECTED`. It adds no model tool and uses no Server Primitive. The decision is one AI SDK model call, or one TypeSafe Jev request for an [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent.

## Configure the gate

Give each category a stable key and a short description.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { llmGate } from 'vite-hub/agent/capabilities'

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

`message` sets the error message server code gets on a reject:

```ts
llmGate({
  allow: { support: 'Support request the Agent can answer.' },
  reject: { unrelated: 'Request unrelated to support.' },
  message: decision => `Rejected: ${decision.category}`,
})
```

## How the gate works

In the input phase, before the Driver:

1. It reads the string `prompt`, else the latest user message text.
2. It builds a classifier prompt from your `prompt`, the categories with `ALLOW:` or `REJECT:` prefixes, recent history when `history` is set, and the user text.
3. It asks the model for `allowed` and `category`, with optional `confidence` (0 to 1) and `reason`.
4. It checks that `category` is one of your keys and sets `allowed` from its group, ignoring the model's `allowed`.
5. It stores the decision as context value `llm-gate`, or your `id`, and as a finish extension under the same id. A second Capability writing that value fails early.
6. A reject category throws `ViteHubError` with `LLM_GATE_REJECTED`. The Driver does not run.

`history: true` includes the last 10 messages; a number includes that many.

### Rejection errors

`runAgent()` callers get a `ViteHubError`:

- Message: the `message` option, or `[vitehub] <id> rejected the request.`.
- `details`: `capabilityId`, `category`, `confidence`, and `reason` (up to 16,384 characters).

HTTP and Invocation clients get status `403` and `{ code: 'LLM_GATE_REJECTED', error: 'Agent request was rejected.', details: { capability, category } }`, without the `message` text or `reason`.

## Jev decisions

An ask Driver Agent without `model` uses TypeSafe Jev:

- One `ask.choice()` question with every category. Jev accepts 2 to 255 choices.
- The state is the run's `data` when set, else `{ request, history? }` from the user text and `history`.
- The decision has `confidence` and `probabilities` (category key to probability), but no `reason`.
- The request goes through the `gateway` option: an [AI gateway](/docs/agents/ai-gateways) such as `cloudflare()`, or `typesafe()`, which reads `TYPESAFE_API_KEY`.

## Requirements

- At least one allow category and one reject category.
- Stable category keys: a letter, then letters, digits, `-`, `_`, or `.`.
- A model. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents give Capabilities none, so set `model`, or the run fails with "requires a model option or an agent model".
- For Jev, the `advocaat` package and the gateway key (`TYPESAFE_API_KEY` for `typesafe()`). See [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver).

## Security and approval

`llmGate()` adds no tool or authority, and has no `policy` option.

> [!WARNING]
> Users control the classified text, and the classifier can be wrong or tricked. Never use it as your only access control. Use authentication and Capability policies.

It sends the user text, category descriptions, and optional history to the model provider or TypeSafe Jev. It does not attach, remove, or grant Capabilities. Later code that depends on the decision must read it.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model or `model`. Runs before model execution. |
| Provider-backed | Requires `model`. Rejected requests do not start the provider. |
| Custom-run-backed | Requires `model`. Rejected requests do not reach `driver.run`. |
| Ask-backed | Without `model`, one Jev `ask.choice()` with every category. With `model`, that model. Rejected requests do not reach the Driver. |

## Verify the gate

1. Allow a run and check the `llm-gate` (or `id`) finish extension or context value for `allowed: true` and the expected `category`.
2. Reject one with `runAgent()`: code `LLM_GATE_REJECTED`, and the Driver did not run.
3. Over HTTP: status `403` and the public body, without `message` or `reason`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | `Record<string, string \| { label?: string; description?: string }>` | required | Allowed categories. Description falls back to `label`, then the key. |
| `reject` | `Record<string, string \| { label?: string; description?: string }>` | required | Rejected categories. Same shape as `allow`. |
| `history` | `boolean \| number` | `false` | Include recent messages. `true` uses 10. |
| `id` | `string` | `"llm-gate"` | Capability id, Invocation context key, and finish extension key. |
| `message` | `string \| (decision) => string` | `"[vitehub] <id> rejected the request."` | Thrown error message. Not sent to HTTP clients. |
| `model` | `AgentModelResolver` | Agent model, or Jev for ask Driver Agents | Model used for the decision. |
| `prompt` | `string` | none | Text before the classifier task. |

## Related pages

- [llmRoute()](/docs/agents/capabilities/llm-route)
- [rateLimit()](/docs/rate-limit/agent-capability)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Official Capabilities](/docs/agents/capabilities/official)
