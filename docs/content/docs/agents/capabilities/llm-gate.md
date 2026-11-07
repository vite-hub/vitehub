---
title: LLM gate
description: Allow or reject an Agent Invocation with a model or TypeSafe Jev decision before the Agent Driver runs.
navigation.title: LLM gate
navigation.order: 280
navigation.group: Capabilities
icon: i-lucide-shield-alert
---

`llmGate()` classifies the request into one allow or reject category before the Agent Driver runs.
It adds no model-facing tool. When the category is a reject category, it stops the Agent Invocation with code `LLM_GATE_REJECTED`.
The decision uses one AI SDK model call, or one TypeSafe Jev request through a [Decisions](/docs/decisions) group with `infer: true` when you set `gateway`. No Server Primitive is involved.

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
2. Each category description gets an `ALLOW:` or `REJECT:` prefix. With `gateway`, or on an ask Driver Agent, it asks Jev which category fits the text best. See [Jev decisions](#jev-decisions).
3. Otherwise it builds a classifier prompt from your `prompt` text, the categories, the recent history when `history` is set, and the user text. It asks `model`, or the Agent model, for a structured object with `allowed`, `category`, and optional `confidence` (0 to 1) and `reason`.
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

Jev decides when the Capability sets `gateway`, or when the Agent uses an [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver), and has no `model` option.
Every category becomes an option of one Decisions group with `multiple: false` and `infer: true`. Jev accepts 2 to 255 categories.
The text is the Invocation `data` as JSON when a caller sets it. Otherwise it is the latest user text, after the recent history when `history` is set. Jev reads the last 16,000 bytes.

The decision has `confidence` and `probabilities`, a map from category key to probability. Jev decisions have no `reason`.
The request goes through the `gateway` option, an [AI gateway](/docs/agents/ai-gateways) such as `vercel()` or `cloudflare()`, or through `typesafe()`, which reads `TYPESAFE_API_KEY`.

## Requirements

- At least one allow category and one reject category.
- Category keys must be stable identifiers: a letter first, then letters, digits, `-`, `_`, or `.`.
- For Jev decisions: the `advocaat` package and the key of the gateway (`TYPESAFE_API_KEY` for the default `typesafe()`, `AI_GATEWAY_API_KEY` for `vercel()`). See [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver).
- For model decisions: a model. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents do not expose an Agent model to Capabilities, so set `model` or `gateway`.

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
| Ask-backed | Jev without options, or `model`. Rejected requests do not reach the Driver. |

## Verify the gate

1. Run one allowed invocation. Read the finish extension or context value for `llm-gate` (or your `id`) and confirm `allowed: true` and the expected `category`.
2. Run one rejected invocation with `runAgent()`. Confirm the error has code `LLM_GATE_REJECTED` and that the Agent Driver did not run.
3. Send the rejected request over HTTP. Confirm status `403` and the public body without the `message` text or `reason`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | `Record<string, string \| { label?: string; description?: string }>` | required | Allowed categories. The description falls back to `label`, then the key. |
| `reject` | `Record<string, string \| { label?: string; description?: string }>` | required | Rejected categories. Same shape as `allow`. |
| `gateway` | `AiGateway` | none, or `typesafe()` for ask Driver Agents | Decide with Jev through this gateway. Ignored when `model` is set. |
| `history` | `boolean \| number` | `false` | Include recent messages in the decision. `true` uses the last 10. |
| `id` | `string` | `"llm-gate"` | Capability id, Invocation context key, and finish extension key. |
| `message` | `string \| (decision) => string` | `"[vitehub] <id> rejected the request."` | Message of the thrown `ViteHubError`. Not sent to HTTP clients. |
| `model` | `AgentModelResolver` | Agent model, or Jev with `gateway` or an ask Driver | Model used for the decision. |
| `prompt` | `string` | none | Text placed before the generated classifier task. |

## Related pages

- [llmRoute()](/docs/agents/capabilities/llm-route)
- [rateLimit()](/docs/rate-limit/agent-capability)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Official Capabilities](/docs/agents/capabilities/official)
