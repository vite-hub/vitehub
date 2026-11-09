---
title: LLM gate
description: Let a model or TypeSafe Jev allow or reject a request before your Agent runs.
navigation.title: LLM gate
navigation.order: 280
navigation.group: Capabilities
icon: i-lucide-shield-alert
---

`llmGate()` puts a request in one allow or reject category before the Agent Driver runs. A reject stops the Invocation (one Agent run) with `LLM_GATE_REJECTED`. It adds no model tool and uses no Server Primitive. The decision is one [Decisions](/docs/decisions) group with `infer: true`. The Agent model answers it, or your `model`, or TypeSafe Jev when you set `gateway`.

## Configure the gate

Give each category a stable key and a short description.

```ts [server/agents/support.ts] fragment
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
import { llmGate } from 'vite-hub/agent/capabilities'

llmGate({
  allow: { support: 'Support request the Agent can answer.' },
  reject: { unrelated: 'Request unrelated to support.' },
  message: decision => `Rejected: ${decision.category}`,
})
```

## How the gate works

In the input phase, before the Driver:

1. It reads the string `prompt`, else the latest user message text.
2. Each category description gets an `ALLOW:` or `REJECT:` prefix. It asks which category fits the text best. See [Decisions](#decisions).
3. It checks that `category` is one of your keys and sets `allowed` from its group, ignoring the model output.
4. It stores the decision as context value `llm-gate`, or your `id`, and as a finish extension under the same id. A second Capability writing that value fails early.
5. If the category is a reject category, it throws `ViteHubError` with code `LLM_GATE_REJECTED`. The Agent Driver does not run.

`history: true` includes the last 10 messages; a number includes that many.

### Rejection errors

The thrown `ViteHubError` has the `message` option text, or `[vitehub] <id> rejected the request.`, and `details` with `capabilityId`, `category`, and `confidence`.
Server code that calls `runAgent()` receives `AGENT_RUN_FAILED` with this error as `error.cause`.

HTTP and Invocation clients receive a public error instead. The HTTP status is `403`. The body is `{ code: 'LLM_GATE_REJECTED', error: 'Agent request was rejected.', details: { capability, category } }`. The `message` text is not sent to the client.

## Decisions

Every category becomes an option of one Decisions group with `multiple: false` and `infer: true`, with 2 to 255 categories.
The text is the run's `data` as JSON when set, else the latest user text with recent `history` before it. It reads up to the last 16,000 bytes of JSON-encoded UTF-8 text, at a code point boundary. Jev leaves room for the choices and question within its 30,000-byte input limit. If these alone cannot fit, use fewer or shorter choices, or set `model`.

Who answers:

- `model`, or the Agent model by default, through [`askWithModel()`](/docs/agents/ai-gateways#ask-with-any-model).
- TypeSafe Jev when you set `gateway`, such as `vercel()` or `cloudflare()`. An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) Agent has no Agent model, so it asks Jev through `typesafe()`, which reads `TYPESAFE_API_KEY`.

The decision has `category`, `allowed`, `confidence`, and `probabilities`, a map from category key to probability. Jev gives a probability for every category. A chat model gives one answer and how sure it is, and the other categories share the rest.

## Requirements

- At least one allow category and one reject category.
- Category keys: a letter, then letters, digits, `-`, `_`, or `.`.
- A model or a gateway. Model-backed Agents use the Agent model. Provider-backed and custom-run-backed Agents give Capabilities no model, so set `model` or `gateway`.
- For Jev: the `advocaat` package and the key of the gateway (`TYPESAFE_API_KEY` for `typesafe()`, `AI_GATEWAY_API_KEY` for `vercel()`).

## Security and approval

`llmGate()` adds no tool or authority, and has no `policy` option.

> [!WARNING]
> Users control the classified text, and the classifier can be wrong or tricked. Never use it as your only access control. Use authentication and Capability policies.

It sends the user text, category descriptions, and optional history to the model provider or TypeSafe Jev. It does not attach, remove, or grant Capabilities. Later code that depends on the decision must read it.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses the Agent model, `model`, or Jev with `gateway`. Runs before model execution. |
| Provider-backed | Requires `model` or `gateway`. Runs before provider execution; rejected requests do not start the provider. |
| Custom-run-backed | Requires `model` or `gateway`. Runs before `driver.run`; rejected requests do not reach custom code. |
| Ask-backed | Jev through `typesafe()` by default, or `model` or `gateway`. Rejected requests do not reach the Driver. |

## Verify the gate

1. Run one allowed invocation. Read the finish extension or context value for `llm-gate` (or your `id`) and confirm `allowed: true` and the expected `category`.
2. Run one rejected invocation with `runAgent()`. Confirm that `error.cause` has code `LLM_GATE_REJECTED` and that the Agent Driver did not run.
3. Send the rejected request over HTTP. Confirm status `403` and the public body without the `message` text.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | `Record<string, string \| { label?: string; description?: string }>` | required | Allowed categories. Description falls back to `label`, then the key. |
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
