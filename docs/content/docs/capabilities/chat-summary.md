---
title: Chat summary
description: Add a summary command that replaces explicit input with a conversation summary.
navigation.title: Chat summary
navigation.order: 210
navigation.group: Decisions and output
icon: i-lucide-file-text
---

`chatSummary()` adds a conversation summary command.
It looks for an explicit command in the latest user input, generates a summary, replaces the command with summary text, and exposes the generated summary as output metadata.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes input behavior similar to `inputCommands()`.
By default it recognizes a summary command, summarizes the current conversation, and writes the summary into Agent Run Input context.

## Configuration

Attach `chatSummary()` with `chat()` when users should request a summary from a chat surface.
The default command uses the standard input command trigger.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { chat, chatSummary } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    chat(),
    chatSummary(),
  ],
})
```

## Runtime behavior

`chatSummary()` runs during the input phase.
When the configured command is present, it removes the command text, summarizes the source messages with a model, custom executor, or heuristic fallback, then replaces the command with `Conversation summary`.

The generated value is available as `chatSummary` in input context and as a finish extension for the invocation that generated it.

## Requirements

The command name must be a valid Input Command name.
Model-based summaries require an explicit model option; otherwise the Capability uses its heuristic fallback.

Disable the command only when another product surface invokes the summary behavior directly.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the transformed input containing the generated summary. |
| Provider-backed | Receives the transformed input before provider execution. |
| Custom-run-backed | Receives the transformed input and context values before `driver.run`. |

## Inspect and verify

Run a chat invocation with the summary command.
Inspect the final Agent Run Input and confirm the command was replaced with `Conversation summary` text.

Inspect the finish extension and verify it appears only on the invocation that generated the summary.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `false \| ChatSummaryCommandOptions` | `{ name: "summary", trigger: "/" }` | Enables or configures the summary Input Command. |
| `command.name` | `string` | `"summary"` | Command name. |
| `command.trigger` | `string` | `"/"` | Command prefix. |
| `command.description` | `string` | generated | Command description. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom summary generator. |
| `fallback` | `string` | `"No conversation to summarize."` | Summary used when generation returns no usable text. |
| `id` | `string` | `"chat-summary"` | Capability id and summary context key prefix. |
| `instructions` | `string` | generated | System instructions for model-backed summaries. |
| `maxLength` | `number` | `1200` | Maximum summary length. |
| `model` | AI SDK model | heuristic fallback | Model used for summaries. |

## Reference

- [chat()](/docs/capabilities/chat)
- [inputCommands()](/docs/capabilities/input-commands)
- Source: `packages/agent/src/capabilities/chat-summary.ts`
