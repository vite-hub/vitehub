---
title: Chat title
description: Generate a short chat title and attach it to Agent output.
navigation.title: Chat title
navigation.order: 200
navigation.group: Decisions and output
icon: i-lucide-heading
---

`chatTitle()` adds title generation for chat-style Agent output.
It can use a model, a custom executor, or a local heuristic, then streams or returns the title as output metadata.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability reads the first user message, generates a short title, provides it as a finish extension, and injects title data into compatible streams.
It can filter by Agent Trigger id when title generation should run only for selected triggers.

## Configuration

Attach `chatTitle()` beside `chat()` for chat surfaces.
When no model is available to the Capability, ViteHub falls back to a short heuristic title.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { chat, chatTitle } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    chat(),
    chatTitle(),
  ],
})
```

## Runtime behavior

`chatTitle()` runs in the output phase.
It wraps compatible async streams or UI message streams so the title can arrive alongside the response, and it provides `{ title }` in the finish extension.

For framework-managed Chat SDK message Channels, ViteHub generates and delivers the title once per thread by default, even when each webhook contains only the current message or the handler is recreated. Follow-up Channel invocations skip title generation after successful delivery. Set `channelDelivery: "always"` when the platform title should be refreshed on every invocation. Plain `runAgent()` and UI invocations without framework-managed Chat SDK delivery still receive stream data and finish extensions per invocation.

The Capability avoids wrapping the same result twice.

## Requirements

`chatTitle()` needs message-shaped input with at least one user message.
A model, custom executor, or heuristic path must be available.

Use a custom template, variables, or executor when the title must include product-specific context.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Can use the Agent model or an explicit model to generate the title and decorate streams. |
| Harness-backed | Can decorate compatible output streams when the invocation produces them; model-based title generation still needs a model resolver. |
| Custom-run-backed | Can decorate compatible custom output; custom `driver.run` controls the response shape. |

## Inspect and verify

Send one chat message and inspect the stream for chat title data.
The finish extension should include `{ title }` when title generation succeeds.

Test a vague first message and confirm the fallback title is used instead of an empty string.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channelDelivery` | `"once-per-thread" \| "always"` | `"once-per-thread"` | Deliver framework-managed Chat SDK Channel titles once per thread, or on every invocation. |
| `driver` | `AgentDriver` | none | Agent Driver used only for title generation. |
| `execute` | `(input) => string \| { title?: string }` | none | Custom title generator. |
| `fallback` | `string` | `"New Conversation"` | Title used when generation returns no usable text. |
| `id` | `string` | `"chat-title"` | Capability id. |
| `instructions` | `string` | none | System instructions for model-backed title generation. |
| `maxLength` | `number` | `80` | Maximum title length. |
| `model` | `AgentModelResolver` | Agent model, then heuristic fallback | Model used for title generation. |
| `template` | `string \| function` | generated | Prompt template for model-backed generation. |
| `trigger` | `string \| string[]` | all triggers | Limit title generation to selected Agent Trigger ids. |
| `variables` | `Record<string, value \| function>` | none | Extra template variables. |
| `when` | `(input) => boolean` | none | Predicate that decides whether title generation runs. |

## Reference

- [chat()](/docs/capabilities/chat)
- [chatSummary()](/docs/capabilities/chat-summary)
- Source: `packages/agent/src/capabilities/chat-title.ts`
