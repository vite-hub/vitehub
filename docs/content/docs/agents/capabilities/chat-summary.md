---
title: Chat summary
description: Let users type /summary to replace their message with a summary of the conversation.
navigation.title: Chat summary
navigation.order: 310
navigation.group: Capabilities
icon: i-lucide-file-text
---

`chatSummary()` lets a user type `/summary` to get a conversation summary. `/summary` is an Input Command, a typed word that changes input before the Agent runs. The Capability replaces the command with the summary before the Agent Driver starts.

The summary comes from your `execute()`, an AI SDK model call, or a local heuristic that cuts the text. It adds no model tool and uses no Server Primitive.

## Configure summaries

Attach it to an Agent that receives conversation messages, such as with `chat()`. `chat()` is optional: the command works on any message input or string prompt.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { chat, chatSummary } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    chat(),
    chatSummary(),
  ],
})
```

Without `model` or `execute`, the heuristic is used. Pass `chatSummary({ model })` for a model summary.

## How summaries work

It runs in the input phase with the [`inputCommands()`](/docs/agents/capabilities/input-commands) parser:

1. It finds the command (default `/summary`) at a word boundary in the latest user message, or the string `prompt`. Text after the name is `args`.
2. It removes the command:
   - Messages: it summarizes the transcript (`role: text` lines). The command message keeps its other text, or is removed if it had only the command.
   - String prompt: it summarizes the text around the command.
3. It summarizes with `execute`, or `model` and the summary instructions, ending the prompt with `Focus: <args>` when `args` is set. The heuristic is the cleaned source cut to `maxLength`.
4. It replaces the command with `Conversation summary:` and the summary on the next line.
5. It puts `{ summary }` in the Agent Run Input context under `chatSummary` and `<id>:summary`, and in a finish extension (data attached to the finished run).

Only the run that made the summary gets the extension, not runs with preset or reused summary context.

## Requirements

- The command name is a valid Input Command name: lowercase, a letter, then letters, digits, `_`, or `-`.
- The trigger is non-empty with no whitespace.
- A model summary needs `model`; the Agent's model is not used.

`command: false` turns it off: input is unchanged and no command metadata is registered.

## Security and approval

There is no model tool or `policy` option. The end user decides when the command runs.

With `model`, the transcript or prompt goes to that provider. The heuristic and `execute` paths call no model unless your code does.

> [!WARNING]
> The summary is model input that comes from the user. Do not trust it as instructions.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets the input with the summary. |
| Provider-backed | Gets the transformed input. |
| Custom-run-backed | Gets the transformed input and context values. |

## Verify summaries

1. `vitehub agent info --agent support --json` lists the `summary` command and trigger in `chat-summary` metadata.
2. Send `/summary` and check that `Conversation summary:` text replaced the command in the final Agent Run Input.
3. Only the summarizing run has the finish extension.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `false \| ChatSummaryCommandOptions` | `{ name: "summary", trigger: "/" }` | Configures the command. `false` turns the Capability off. |
| `command.name` | `string` | `"summary"` | Command name. |
| `command.trigger` | `string` | `"/"` | Command prefix. |
| `command.description` | `string` | `"Summarize this conversation."` | Command description in metadata. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom generator. Gets `args`, `input`, `messages`, and `text`. |
| `fallback` | `string` | `"No conversation to summarize."` | Used when there is no usable text. |
| `id` | `string` | `"chat-summary"` | Capability id, finish extension key, and `<id>:summary` prefix. |
| `instructions` | `string` | generated | System instructions for model-backed summaries. |
| `maxLength` | `number` | `1200` | Maximum summary length. |
| `model` | AI SDK model | none (heuristic) | Model for `generateText()`. |

## Related pages

- [chat()](/docs/agents/capabilities/chat)
- [inputCommands()](/docs/agents/capabilities/input-commands)
- [title()](/docs/agents/capabilities/title)
- [Official Capabilities](/docs/agents/capabilities/official)
