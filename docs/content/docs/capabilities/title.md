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

The Capability reads the prepared first user message, generates a short title, provides it as a finish extension, and injects title data into compatible streams.
When that message has no semantic text, such as an attachment-only audio or image message, it waits for the successful Agent reply and uses that text instead.
Applications can use the finish extension to name a job, run, artifact, or other durable record without depending on a chat interface.
It can limit title generation to selected Agent Trigger ids.

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

The Capability avoids wrapping the same result twice.

## Requirements

`title()` needs message-shaped input with at least one user message and semantic text from either the prepared input or a successful Agent reply.
A model, custom executor, or heuristic path must be available.

Use a custom template, variables, or executor when the title must include product-specific context.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Can use the Agent model or an explicit model to generate the title and decorate streams. |
| Provider-backed | Can decorate compatible output streams when the invocation produces them; model-based title generation still needs a model resolver. |
| Custom-run-backed | Can decorate compatible custom output; custom `driver.run` controls the response shape. |

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
| `maxLength` | `number` | `80` | Maximum title length. |
| `model` | `AgentModelResolver` | Agent model, then heuristic fallback | Model used for title generation. |
| `template` | `string \| function` | generated | Prompt template for model-backed generation. String templates can use `{{ message }}` and `{{ source }}`. |
| `trigger` | `string \| string[]` | all triggers | Limit title generation to selected Agent Trigger ids. |
| `variables` | `Record<string, value \| function>` | none | Extra template variables. |
| `when` | `(input) => boolean` | none | Predicate that decides whether title generation runs. |

## Related pages

- [chat()](/docs/capabilities/chat)
- [chatSummary()](/docs/capabilities/chat-summary)
