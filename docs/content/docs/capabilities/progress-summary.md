---
title: Progress summary
description: Stream a short user-facing summary of current Agent activity.
navigation.title: Progress summary
navigation.order: 210
navigation.group: Decisions and output
icon: i-lucide-message-circle-more
---

`progressSummary()` observes reasoning presence and tool lifecycle events while an Agent works, then emits a replaceable one-sentence status as transient `data-progress-summary` stream data.

Adapter-backed message Channels enable it by default. ViteHub posts `Working on it…`, replaces that message with safe progress summaries when the Driver exposes useful events, deletes it on completion, and posts the final reply as a new message. GitHub Channels are not message Channels, so they keep their single final delivery.

## Add progress summaries

Import the Capability from `@vite-hub/agent/capabilities` and give it the independent Agent Driver that should write progress:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { progressSummary } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: primaryDriver,
  capabilities: [
    progressSummary({
      driver: {
        kind: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
      },
    }),
  ],
})
```

The Capability owns the summarizer instructions. The configured Driver selects the model and execution environment using the same contract as an Agent Definition or `title()`.

## Render the current summary

Listen for `data-progress-summary` parts and replace the currently displayed sentence when `revision` increases:

```ts
{
  type: 'data-progress-summary',
  data: {
    type: 'progress-summary',
    summary: 'Checking current SKU costs against the planning data.',
    revision: 1,
  },
}
```

The part is transient, so it does not become conversation history. Keep structured reasoning and tool logs separate when your interface exposes them.

With adapter-backed message delivery, ViteHub edits the current placeholder as summaries arrive. When the Agent finishes, ViteHub deletes that placeholder and posts the final reply as a new message so chat platforms can deliver their normal notification. Set `messages.fallbackStreamingPlaceholderText` to `null` on a Channel to opt out.

## Understand the runtime behavior

With event-driven `intervalMs: 0`, the Capability starts its initial summary when the first non-terminal primary stream chunk arrives. A terminal-only or failed stream does not start unused auxiliary work.

Positive intervals begin when the first primary stream chunk arrives and use a fixed cadence from that point, so auxiliary generation never delays primary Driver startup and a slow generation does not postpone the next tick. Generations can overlap; each receives a higher revision, and a stale completion cannot replace a newer completed revision. Set `intervalMs: 0` to generate from reasoning and tool activity through the event-driven microtask behavior instead. Raw reasoning, tool input, and tool output are excluded from the generated prompt; reasoning is represented only as an `Active` presence signal.

The default prompt uses only reasoning presence, sanitized tool names, and the previous summary. It does not include user message text, code, commands, paths, traces, hidden instructions, credentials, raw tool details, or trusted `<context>` payloads.

The Capability stops its cadence and aborts every in-flight generation when the parent invocation aborts or the primary stream finishes, cancels, or errors. A generation failure does not interrupt the primary response stream; ViteHub emits a sanitized warning and trace event without logging the Driver error message.

## Requirements

Streaming Drivers expose progress through their async or UI message stream. Model-backed non-streaming Drivers use AI SDK step-finish events. With a positive interval, the Capability attempts a summary on every tick and suppresses unchanged output. With `intervalMs: 0`, it remains silent after the first event until reasoning presence or tool lifecycle events provide new activity.

Configure a `driver`, `model`, or `execute` option for summary generation. Without one of those options, the Capability uses the Agent model when available.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses an explicit summary model or the Agent model. |
| Harness-backed | Uses an independent Harness Driver, including its model and reasoning settings. |
| Custom-run-backed | Uses an independent custom Driver or the `execute` callback. |

## Verify the result

Run an invocation and confirm that the primary stream continues immediately while an initial transient `data-progress-summary` part arrives. Keep the invocation open beyond `intervalMs`, then confirm that a later changed summary arrives with a higher `revision`.

Stop the invocation before the next interval and confirm that no later progress part appears.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `AgentDriver` | none | Independent Agent Driver used for progress generation. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom progress generator. |
| `id` | `string` | `"progress-summary"` | Capability id. |
| `instructions` | `string` | Capability-owned instructions | System instructions for model-backed generation. |
| `intervalMs` | `number` | `10000` | Fixed generation cadence. Use `0` for event-driven updates. |
| `maxLength` | `number` | `180` | Maximum summary length. |
| `model` | `AgentModelResolver` | Agent model | Model used when no independent Driver is configured. |
| `template` | `string \| function` | generated | Markdown prompt template. |
| `variables` | `Record<string, value \| function>` | none | Extra Markdown template variables. |

String templates use `@vite-hub/markdown-template` and receive `userText`, the `reasoning` presence signal, `activeTools`, `completedTools`, and `previous`. Referencing `userText` opts a custom template into handling user message text; keep sensitive content out of prompts you construct.

## Reference

- [title()](/docs/capabilities/title)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Markdown pages](/docs/ai-resources/markdown-pages)
- Source: `packages/agent/src/capabilities/progress-summary.ts`
