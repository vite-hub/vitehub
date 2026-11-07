---
title: LLM gate
description: Allow or reject an Agent Invocation with a Decisions choice, answered by any model or TypeSafe Jev, before the Agent Driver runs.
navigation.title: LLM gate
navigation.order: 280
navigation.group: Capabilities
icon: i-lucide-shield-alert
---

`llmGate()` classifies the request into one allow or reject category before the Agent Driver runs.
It adds no model-facing tool. When the category is a reject category, it stops the Agent Invocation with code `LLM_GATE_REJECTED`.
The decision is one [Decisions](/docs/decisions) group with `infer: true`. The Agent model answers it, or the `model` you pass, or TypeSafe Jev when you set `gateway`. No Server Primitive is involved.

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
2. Each category description gets an `ALLOW:` or `REJECT:` prefix. It asks which category fits the text best. See [Decisions](#decisions).
3. It validates that `category` is a configured key. ViteHub sets `allowed` from the category group, not from the model output.
4. It stores the decision as the Invocation context value `llm-gate` (or your `id`) and provides it as a finish extension under the same id.
5. If the category is a reject category, it throws `ViteHubError` with code `LLM_GATE_REJECTED`. The Agent Driver does not run.

A second writer for the same context value fails early.
`history: true` includes the last 10 messages. A number includes that many messages.

### Rejection errors

The thrown `ViteHubError` has the `message` option text, or `[vitehub] <id> rejected the request.`, and `details` with `capabilityId`, `category`, and `confidence`.
Server code that calls `runAgent()` receives this error.

HTTP and Invocation clients receive a public error instead. The HTTP status is `403`. The body is `{ code: 'LLM_GATE_REJECTED', error: 'Agent request was rejected.', details: { capability, category } }`. The `message` text is not sent to the client.

## Decisions

Every category becomes an option of one Decisions group with `multiple: false` and `infer: true`, with 2 to 255 categories.
The text is the Invocation `data` as JSON when a caller sets it. Otherwise it is the latest user text, after the recent history when `history` is set. The decision reads the last 16,000 bytes.

Who answers:

- `model`, or the Agent model by default, through [`askWithModel()`](/docs/agents/ai-gateways#ask-with-any-model).
- TypeSafe Jev when you set `gateway`, such as `vercel()` or `cloudflare()`. An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent has no Agent model, so it asks Jev through `typesafe()`, which reads `TYPESAFE_API_KEY`.

The decision has `category`, `allowed`, `confidence`, and `probabilities`, a map from category key to probability. Jev gives a probability for every category. A chat model gives one answer and how sure it is, and the other categories share the rest.

## Requirements

- At least one allow category and one reject category.
- Category keys must be stable identifiers: a letter first, then letters, digits, `-`, `_`, or `.`.
- A model or a gateway. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents do not expose an Agent model to Capabilities, so set `model` or `gateway`.
- For Jev: the `advocaat` package and the key of the gateway (`TYPESAFE_API_KEY` for `typesafe()`, `AI_GATEWAY_API_KEY` for `vercel()`).

## Security and approval

`llmGate()` adds no model-facing tool, so the Agent gets no new authority. It has no `policy` option.
The end user controls the classified text. The classifier can be wrong or manipulated by that text, so do not use the gate as the only access control. Use authentication and Capability policies for authority.

The gate sends the latest user text, the category descriptions, and the optional history to the configured model provider or to TypeSafe Jev.
It does not attach, remove, or grant Capabilities. Later behavior must read the recorded decision explicitly.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model, `model`, or Jev with `gateway`. Runs before model execution. |
| Provider-backed | Requires `model` or `gateway`. Runs before provider execution; rejected requests do not start the provider. |
| Custom-run-backed | Requires `model` or `gateway`. Runs before `driver.run`; rejected requests do not reach custom code. |
| Ask-backed | Jev through `typesafe()` by default, or `model` or `gateway`. Rejected requests do not reach the Driver. |

## Verify the gate

1. Run one allowed invocation. Read the finish extension or context value for `llm-gate` (or your `id`) and confirm `allowed: true` and the expected `category`.
2. Run one rejected invocation with `runAgent()`. Confirm the error has code `LLM_GATE_REJECTED` and that the Agent Driver did not run.
3. Send the rejected request over HTTP. Confirm status `403` and the public body without the `message` text.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | `Record<string, string \| { label?: string; description?: string }>` | required | Allowed categories. The description falls back to `label`, then the key. |
| `reject` | `Record<string, string \| { label?: string; description?: string }>` | required | Rejected categories. Same shape as `allow`. |
| `gateway` | `AiGateway` | none, or `typesafe()` for ask Driver Agents | Ask TypeSafe Jev through this gateway instead of a model. Ignored when `model` is set. |
| `history` | `boolean \| number` | `false` | Include recent messages in the decision. `true` uses the last 10. |
| `id` | `string` | `"llm-gate"` | Capability id, Invocation context key, and finish extension key. |
| `message` | `string \| (decision) => string` | `"[vitehub] <id> rejected the request."` | Message of the thrown `ViteHubError`. Not sent to HTTP clients. |
| `model` | `AgentModelResolver` | Agent model | Model that answers the decision. |
| `prompt` | `string` | none | Text placed before the generated classifier task. |

## Related pages

- [llmRoute()](/docs/agents/capabilities/llm-route)
- [rateLimit()](/docs/rate-limit/agent-capability)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Official Capabilities](/docs/agents/capabilities/official)
