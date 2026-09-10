---
title: Title
description: Generate a short title and attach it to Agent output.
navigation.title: Title
navigation.order: 200
navigation.group: Decisions and output
icon: i-lucide-heading
---

`title()` generates a short title for an Agent Invocation.
It can use a model, a custom executor, or a local heuristic, then streams or returns the title as output metadata and optionally delivers it to a Channel thread.

The Capability reads the prepared first user message, or `input.prompt` when no user message is present. It generates a short title, provides it as a finish extension, and injects title data into compatible streams.
When that message has no semantic text, such as an attachment-only audio or image message, it waits for the successful Agent reply and uses that text instead.
Applications can use the finish extension to name a job, run, artifact, or other durable record without depending on a chat interface.
It can limit title generation to selected Agent Trigger ids.

The default generation prompt follows T3 Code’s editorial rules: name the subject and desired outcome in 3–8 words, under 40 characters. It requests a JSON object with a `title` field. Output is normalized to one line and bounded by `maxLength`. An explicit title Driver uses `fallback` on failure or timeout; this does not prevent the main answer.

## Configure titles

Attach `title()` to any Agent Definition that needs a generated title.
When no model is available to the Capability, ViteHub falls back to a short heuristic title.

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

`title()` runs in the output phase.
It wraps compatible async streams or UI message streams so the title can arrive alongside the response, and it provides `{ title }` in the finish extension.

Input Capabilities run first, so `transcribe()` can replace audio with transcript text before `title()` reads it. Audio with authored text uses both in their prepared order. If the prepared input is still empty, `title()` waits for the normalized Agent reply; when that reply is also empty or the invocation fails, it leaves the title unset.

For framework-managed Chat SDK message Channels, ViteHub also delivers the title once per thread by default, even when each webhook contains only the current message or the handler is recreated. Follow-up Channel invocations skip title generation after successful delivery. Set `channelDelivery: "always"` to refresh the platform title on every invocation. Plain `runAgent()` and UI invocations without framework-managed Chat SDK delivery still receive stream data and finish extensions per invocation.

When an Invocation journal is configured, title generation starts beside the main answer. Invocation cleanup waits for this work, subject to the title timeout and invocation abort signal. Metadata journals retain the generated text only when `metadataContent` includes `vitehub.session.title`; the Console enables this selection.

The Capability avoids wrapping the same result twice.

## Requirements

`title()` accepts a text `prompt` or message input with at least one user message. It needs semantic text from the prepared input or a successful Agent reply.
A model, custom executor, or heuristic path must be available.

Use a custom template, variables, or executor when the title must include product-specific context.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Can use the Agent model or an explicit model to generate the title and decorate streams. |
| Provider-backed | Starts an auxiliary title run through the inherited provider Driver unless `execute`, `driver`, or a non-string `model` overrides it. Can decorate compatible output streams. |
| Custom-run-backed | Can decorate compatible custom output; custom `driver.run` controls the response shape. |

On a provider-backed Agent, `title()` inherits the provider model, credentials, environment, launch configuration, and permissions. It uses title-specific instructions and an isolated credential profile. A string `model` changes the inherited provider's model name; a model object or resolver uses the AI SDK path instead.

The auxiliary title run can incur additional provider usage. Title generation has a default 20-second timeout, configurable with `timeoutMs`. Consumers that await the title, including finish hooks and Invocation cleanup, can wait for that work to settle. Use `execute` for a custom generator that avoids a provider call.

## Verify titles

Run one Agent Invocation and inspect the stream for title data.
Confirm that the finish extension includes `{ title }` when title generation succeeds.

Test a vague first message and confirm the fallback title is used instead of an empty string.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channelDelivery` | `"once-per-thread" \| "always"` | `"once-per-thread"` | Deliver framework-managed Chat SDK Channel titles once per thread, or on every invocation. |
| `driver` | `AgentDriver` | none | Agent Driver used only for title generation. |
| `execute` | `(input) => string \| { title?: string }` | none | Custom title generator. `input.source` is `"input"` or `"response"`. |
| `fallback` | `string` | `"Untitled"` | Title used when generation returns no usable text. |
| `id` | `string` | `"title"` | Capability id. |
| `instructions` | `string` | none | System instructions for model-backed title generation. |
| `maxLength` | `number` | `39` | Maximum title length. |
| `model` | `AgentModelResolver` | Inherited provider Driver, otherwise Agent model then heuristic fallback | A string overrides the inherited provider model name. A model object or resolver selects the AI SDK path. |
| `reasoningEffort` | `string` | Inherited provider Driver setting | Override reasoning effort only for title generation through the inherited provider Driver. When omitted, preserve the Driver's reasoning configuration, including environment-based settings. Does not apply to an explicit title `driver`, custom `execute`, or AI SDK model. |
| `template` | `string \| function` | generated | Prompt template for model-backed generation. String templates can use `{{ message }}` and `{{ source }}`. |
| `timeoutMs` | `number` | `20_000` | Maximum time for title generation before fallback; also respects invocation cancellation. |
| `trigger` | `string \| string[]` | all triggers | Limit title generation to selected Agent Trigger ids. |
| `variables` | `Record<string, value \| function>` | none | Extra template variables. |
| `when` | `(input) => boolean` | none | Predicate that decides whether title generation runs. |

## Related pages

- [chat()](/docs/capabilities/chat)
- [chatSummary()](/docs/capabilities/chat-summary)

## Inspect title generation

Open an Invocation's **Capabilities** tab and select **Title**. The view shows the recorded generation state, generated title, generation method, configured model, length limit, timeout, trigger, and channel delivery mode. A custom `id` retains the same Title view.

Snapshots update during title generation and remain available after the Invocation ends. Reading them does not generate another title. The view follows configuration retention; use `configuration: 'content'` on the Invocation journal to keep its data independently of prompt and answer content.
