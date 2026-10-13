---
title: LLM gate
description: Allow or reject an Agent Invocation with a model decision before the Agent Driver runs.
navigation.title: LLM gate
navigation.order: 280
navigation.group: Capabilities
icon: i-lucide-shield-alert
---

`llmGate()` classifies the request into one allow or reject category before the Agent Driver runs.
It adds no model-facing tool. When the category is a reject category, it stops the Agent Invocation with code `LLM_GATE_REJECTED`.
The decision uses one AI SDK model call, or one TypeSafe Jev request for an [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent. No Server Primitive is involved.

## Configure the gate

Define allow and reject categories with stable keys and short descriptions.

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

Set `message` to change the error message that server code receives on rejection:

```ts
llmGate({
  allow: { support: 'Support request the Agent can answer.' },
  reject: { unrelated: 'Request unrelated to support.' },
  message: decision => `Rejected: ${decision.category}`,
})
```

## How the gate works

`llmGate()` runs in the input phase, before the Agent Driver.

1. It reads the latest user text: the string `prompt`, or else the text of the latest user message.
2. It builds a classifier prompt from your `prompt` text, the categories (each description gets an `ALLOW:` or `REJECT:` prefix), the recent history when `history` is set, and the user text.
3. It resolves the model and asks for a structured object with `allowed`, `category`, and optional `confidence` (0 to 1) and `reason`.
4. It validates that `category` is a configured key. ViteHub sets `allowed` from the category group, not from the model output.
5. It stores the decision as the Invocation context value `llm-gate` (or your `id`) and provides it as a finish extension under the same id.
6. If the category is a reject category, it throws `ViteHubError` with code `LLM_GATE_REJECTED`. The Agent Driver does not run.

A second writer for the same context value fails early.
`history: true` includes the last 10 messages. A number includes that many messages.

### Rejection errors

The thrown `ViteHubError` has the `message` option text, or `[vitehub] <id> rejected the request.`, and `details` with `capabilityId`, `category`, `confidence`, and `reason` (up to 16,384 characters).
Server code that calls `runAgent()` receives this error.

HTTP and Invocation clients receive a public error instead. The HTTP status is `403`. The body is `{ code: 'LLM_GATE_REJECTED', error: 'Agent request was rejected.', details: { capability, category } }`. The `message` text and the model `reason` are not sent to the client.

## Jev decisions

An ask Driver Agent sends the gate to TypeSafe Jev when the Capability has no `model` option.
It asks one `ask.choice()` question with every category. Jev accepts 2 to 255 choices.
The state is the Invocation `data` when a caller sets it. Otherwise it is `{ request, history? }` from the latest user text and the `history` option.

The decision has `confidence` and `probabilities`, a map from category key to probability. Jev decisions have no `reason`.
Credentials come from the `typesafe` Server Env group, as for the ask Driver.

## Requirements

- At least one allow category and one reject category.
- Category keys must be stable identifiers: a letter first, then letters, digits, `-`, `_`, or `.`.
- A model. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents do not expose an Agent model to Capabilities, so set `model`. Without a model, the invocation fails with "requires a model option or an agent model".
- For Jev decisions: the `advocaat` package and the `typesafe` Server Env group. See [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver).

## Security and approval

`llmGate()` adds no model-facing tool, so the Agent gets no new authority. It has no `policy` option.
The end user controls the classified text. The classifier can be wrong or manipulated by that text, so do not use the gate as the only access control. Use authentication and Capability policies for authority.

The gate sends the latest user text, the category descriptions, and the optional history to the configured model provider or to TypeSafe Jev.
It does not attach, remove, or grant Capabilities. Later behavior must read the recorded decision explicitly.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model or `model`. Runs before model execution. |
| Provider-backed | Requires `model`. Runs before provider execution; rejected requests do not start the provider. |
| Custom-run-backed | Requires `model`. Runs before `driver.run`; rejected requests do not reach custom code. |
| Ask-backed | Without `model`, asks Jev one `ask.choice()` question with every category. With `model`, uses that model. Rejected requests do not reach the Driver. |

## Verify the gate

1. Run one allowed invocation. Read the finish extension or context value for `llm-gate` (or your `id`) and confirm `allowed: true` and the expected `category`.
2. Run one rejected invocation with `runAgent()`. Confirm the error has code `LLM_GATE_REJECTED` and that the Agent Driver did not run.
3. Send the rejected request over HTTP. Confirm status `403` and the public body without the `message` text or `reason`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | `Record<string, string \| { label?: string; description?: string }>` | required | Allowed categories. The description falls back to `label`, then the key. |
| `reject` | `Record<string, string \| { label?: string; description?: string }>` | required | Rejected categories. Same shape as `allow`. |
| `history` | `boolean \| number` | `false` | Include recent messages in the decision. `true` uses the last 10. |
| `id` | `string` | `"llm-gate"` | Capability id, Invocation context key, and finish extension key. |
| `message` | `string \| (decision) => string` | `"[vitehub] <id> rejected the request."` | Message of the thrown `ViteHubError`. Not sent to HTTP clients. |
| `model` | `AgentModelResolver` | Agent model, or Jev for ask Driver Agents | Model used for the decision. |
| `prompt` | `string` | none | Text placed before the generated classifier task. |

## Related pages

- [llmRoute()](/docs/agents/capabilities/llm-route)
- [rateLimit()](/docs/rate-limit/agent-capability)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Official Capabilities](/docs/agents/capabilities/official)
