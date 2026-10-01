---
title: Chat summary
description: Add a summary command that replaces explicit input with a conversation summary.
navigation.title: Chat summary
navigation.order: 210
navigation.group: Decisions and output
icon: i-lucide-file-text
---

`chatSummary()` adds a `/summary` Input Command that the user types into the latest message.
It adds no model-facing tool. When the command is present, it summarizes the conversation and replaces the command with the summary text before the Agent Driver runs.
The summary comes from a custom `execute()` function, an AI SDK model call, or a local heuristic. No Server Primitive is involved.

## Configure summaries

Attach `chatSummary()` to an Agent that receives conversation messages, for example with `chat()`.
`chat()` is not required; the command works on any message or string prompt input.

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

Without `model` or `execute`, the Capability uses its heuristic summary. Pass `chatSummary({ model })` for a model-generated summary.

## How summaries work

`chatSummary()` runs in the input phase. It uses the same command parser as [`inputCommands()`](/docs/capabilities/input-commands).

1. It looks for the command (default `/summary`) in the latest user message, or in the string `prompt` when there are no messages. The command must start at a word boundary. Text after the command name is `args`.
2. It removes the command from the source:
   - Message input: it summarizes the conversation transcript (`role: text` lines). The command message keeps its other text, or is dropped when only the command remains.
   - String prompt input: it summarizes the prompt text around the command.
3. It generates the summary with `execute`, or with `model` and the summary instructions. When `args` is set, the model prompt ends with `Focus: <args>`. Without `execute` or `model`, the heuristic summary is the normalized source text cut to `maxLength`.
4. It replaces the command with `Conversation summary:` and the summary on the next line.
5. It sets `{ summary }` in Agent Run Input context under `chatSummary` and `<id>:summary`, and provides it as a finish extension.

The finish extension appears only on the invocation that generated the summary. Summary context that a caller sets in advance, or that a later run reuses, does not produce the extension.

## Requirements

- The command name must be a valid Input Command name: lowercase, a letter first, then letters, digits, `_`, or `-`.
- The command trigger must be a non-empty string without whitespace.
- A model-based summary requires the `model` option. The Capability does not use the Agent model.

Set `command: false` to turn the command off. The Capability then does not change input and does not register command metadata.

## Security and approval

`chatSummary()` adds no model-facing tool and has no `policy` option.
The end user controls when the command runs. With `model`, ViteHub sends the conversation transcript, or the prompt text, to that model provider. The heuristic and `execute` paths do not call a model unless your `execute` code does.

The summary replaces the command in the model input. Treat it as user-derived content, not as trusted instructions.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the transformed input that contains the summary. |
| Provider-backed | Receives the transformed input before provider execution. |
| Custom-run-backed | Receives the transformed input and context values before `driver.run`. |

## Verify summaries

1. Run `vitehub agent info --agent support --json` and confirm that the `chat-summary` Capability metadata lists the `summary` command and its trigger.
2. Run a chat invocation with `/summary`. Inspect the final Agent Run Input and confirm that the command was replaced with `Conversation summary:` text.
3. Inspect the finish extension and confirm that it appears only on the invocation that generated the summary.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `false \| ChatSummaryCommandOptions` | `{ name: "summary", trigger: "/" }` | Enables or configures the summary Input Command. `false` turns the Capability off. |
| `command.name` | `string` | `"summary"` | Command name. |
| `command.trigger` | `string` | `"/"` | Command prefix. |
| `command.description` | `string` | `"Summarize this conversation."` | Command description in metadata. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom summary generator. Receives `args`, `input`, `messages`, and `text`. |
| `fallback` | `string` | `"No conversation to summarize."` | Summary used when generation returns no usable text. |
| `id` | `string` | `"chat-summary"` | Capability id, finish extension key, and prefix of the `<id>:summary` context key. |
| `instructions` | `string` | generated | System instructions for model-backed summaries. |
| `maxLength` | `number` | `1200` | Maximum summary length. |
| `model` | AI SDK model | none (heuristic) | Model passed to `generateText()` for summaries. |

## Related pages

- [chat()](/docs/capabilities/chat)
- [inputCommands()](/docs/capabilities/input-commands)
- [title()](/docs/capabilities/title)
- [Official Capabilities](/docs/capabilities/official-capabilities)
