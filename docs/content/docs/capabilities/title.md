---
title: Title
description: Generate a short title for an Agent Invocation and attach it to output, finish hooks, and Channel threads.
navigation.title: Title
navigation.order: 200
navigation.group: Decisions and output
icon: i-lucide-heading
---

`title()` generates a short title for an Agent Invocation.
It adds no model-facing tool. It streams the title as output data, provides `{ title }` as a finish extension, and can deliver it to a Channel thread.
Generation uses a custom `execute()` function, a separate title Driver, the inherited provider Driver, an AI SDK model call, or a local heuristic. No Server Primitive is involved.

Applications can use the finish extension to name a job, run, artifact, or other durable record without a chat interface.

## Configure titles

Attach `title()` to any Agent Definition that needs a generated title.
When no generator is available, ViteHub uses a short heuristic title.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { title } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    title(),
  ],
})
```

## How titles are generated

`title()` reads the prepared first user message, or `input.prompt` when no user message is present.
Input Capabilities run first, so `transcribe()` can replace audio with transcript text before `title()` reads it. Audio with authored text uses both in their prepared order.
When the message has no semantic text, such as an attachment-only audio or image message, `title()` waits for the successful Agent reply and uses that text. When the reply is also empty or the invocation fails, it leaves the title unset.

ViteHub selects one generator in this order:

1. `execute`, when set.
2. `driver`, when set.
3. The inherited provider Driver, when the Agent uses a provider-backed Driver and `model` is unset or a string.
4. An AI SDK model: `model`, or else the Agent model.
5. A heuristic title from the first six words of the source text.

The default prompt follows T3 Code's editorial rules: name the subject and desired outcome in 3 to 8 words, under 40 characters. It requests a JSON object with a `title` field.
ViteHub keeps the first line, removes quotes, and bounds the result by `maxLength`. Empty output uses `fallback`.

When generation fails, the result depends on the generator:

- An explicit `driver` uses `fallback` on any failure or timeout.
- The inherited provider Driver uses the heuristic title on any failure or timeout.
- `execute` and the AI SDK model use the heuristic title on timeout. Other errors leave the title unset.

A title failure does not stop the main answer.

### Stream output

`title()` wraps compatible async streams and UI message streams, so the title can arrive alongside the response. It does not wrap the same result twice.

- UI message streams receive `{ type: 'data-title', id: 'title', data: { type: 'title', title } }`. A provisional heuristic title can arrive first. The generated title replaces it with the same part id.
- Async streams and `fullStream` receive `{ type: 'data', data: { type: 'title', title } }`.

Finish hooks read the title with `event.extensions.get('title')`, or with your custom `id`.

### Channel delivery

For framework-managed Chat SDK message Channels, ViteHub delivers the title once per thread by default, even when each webhook contains only the current message or the handler is recreated. Follow-up Channel invocations skip title generation after successful delivery. Set `channelDelivery: "always"` to refresh the platform title on every invocation.
When a Channel invocation fails after title generation started, ViteHub delivers the title with an `ERROR:` prefix.

Plain `runAgent()` and UI invocations without framework-managed Chat SDK delivery still receive stream data and finish extensions per invocation.

### Invocation journals

When an Invocation journal is configured, title generation starts beside the main answer. Invocation cleanup waits for this work, subject to the title timeout and the invocation abort signal.
Metadata journals retain the generated text only when `metadataContent` includes `vitehub.session.title`. The Console enables this selection.

## Provider-backed title runs

On a provider-backed Agent, `title()` starts an auxiliary title run through the inherited provider Driver. The run inherits the provider model, credentials, environment, launch configuration, and permissions. It uses title-specific instructions and does not reuse the main Driver's credential profile.
A string `model` changes the inherited provider's model name. A model object or resolver uses the AI SDK path instead.
`reasoningEffort` changes reasoning effort only for this run and requires an inherited Codex Driver.

The auxiliary title run can add provider usage. ViteHub records title model usage as auxiliary usage on the Invocation usage record.
Title generation has a default 20-second timeout, configurable with `timeoutMs`. Consumers that await the title, including finish hooks and Invocation cleanup, can wait for that work to settle. Use `execute` for a custom generator that avoids a provider call.

## Inspect title generation

Open an Invocation's **Capabilities** tab and select **Title**. The view shows the recorded generation state, generated title, generation method, configured model, length limit, timeout, trigger, and Channel delivery mode. A custom `id` keeps the same Title view.

Snapshots update during title generation and remain available after the Invocation ends. Reading them does not generate another title. The view follows configuration retention; use `configuration: 'content'` on the Invocation journal to keep its data independently of prompt and answer content.

## Requirements

- A text `prompt` or message input with at least one user message.
- Semantic text from the prepared input or a successful Agent reply.
- A title `driver` must return text. `driver.ask` is not supported.
- `reasoningEffort` requires an inherited Codex Driver. Other provider Drivers fail with `AGENT_R0924`.
- Provider Drivers, including a provider Driver passed to `title({ driver })`, need a Node.js host. A Cloudflare Worker build fails with `AGENT_B0019`.

Use `template`, `variables`, or `execute` when the title must include product-specific context.

## Security and approval

`title()` adds no model-facing tool and has no `policy` option.
The end user controls the source text. For model and Driver prompts, ViteHub sends up to the last 8,000 characters of that text, with Chat entity markup removed. A custom `execute` function receives the complete timed input, so it must enforce its own input limit. The default prompt tells the model to treat the source as data, not instructions.

An inherited provider title run has the same permissions as the main provider Driver. Use `execute`, a separate `driver`, or an AI SDK `model` when the title run must have less authority.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses `model` or the Agent model. Decorates compatible output streams. |
| Provider-backed | Starts an auxiliary title run through the inherited provider Driver unless `execute`, `driver`, or a non-string `model` overrides it. Decorates compatible output streams. |
| Custom-run-backed | No Agent model is available, so set `execute`, `driver`, or `model`; otherwise uses the heuristic title. Decorates compatible custom output; `driver.run` controls the response shape. |

## Verify titles

1. Run one Agent Invocation and inspect the stream for a `data-title` part or a `title` data event.
2. Add an `agent:finish` hook and confirm that `event.extensions.get('title')` returns `{ title }`.
3. Use `execute: () => ''` and confirm that the title is the `fallback` value, not an empty string.
4. Open the Invocation in the Console and check the **Title** view.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channelDelivery` | `"once-per-thread" \| "always"` | `"once-per-thread"` | Deliver framework-managed Chat SDK Channel titles once per thread, or on every invocation. |
| `driver` | `AgentDriver` | none | Agent Driver used only for title generation. Must return text. |
| `execute` | `(input) => string \| { title?: string }` | none | Custom title generator. `input.source` is `"input"` or `"response"`. |
| `fallback` | `string` | `"Untitled"` | Title used when generation returns no usable text, or when an explicit `driver` fails. |
| `id` | `string` | `"title"` | Capability id and finish extension key. |
| `instructions` | `string` | none | System instructions for the AI SDK model path, the inherited provider title run, and an explicit model-backed `driver`. |
| `maxLength` | `number` | `39` | Maximum title length. |
| `model` | `AgentModelResolver` | Inherited provider Driver, otherwise Agent model, then heuristic | A string overrides the inherited provider model name. A model object or resolver selects the AI SDK path. |
| `reasoningEffort` | `string` | Inherited provider Driver setting | Override reasoning effort only for the inherited Codex title run. When omitted, preserve the Driver's reasoning configuration, including environment-based settings. Does not apply to an explicit title `driver`, custom `execute`, or AI SDK model. |
| `template` | `string \| function` | generated | Prompt template. String templates can use `{{ message }}`, `{{ source }}`, `{{ fallback }}`, `{{ maxLength }}`, `{{ trigger }}`, and `variables`. |
| `timeoutMs` | `number` | `20_000` | Maximum time for title generation; also respects invocation cancellation. |
| `trigger` | `string \| string[]` | all triggers | Limit title generation to selected Agent Trigger ids. |
| `variables` | `Record<string, value \| function>` | none | Extra template variables. |
| `when` | `(input) => boolean` | none | Predicate that decides whether title generation runs. |

## Related pages

- [chat()](/docs/capabilities/chat)
- [chatSummary()](/docs/capabilities/chat-summary)
- [progressSummary()](/docs/capabilities/progress-summary)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Channels](/docs/agents/channels)
- [Official Capabilities](/docs/capabilities/official-capabilities)
