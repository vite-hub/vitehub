---
title: Progress summary
description: Stream a short user-facing summary of current Agent activity.
navigation.title: Progress summary
navigation.order: 211
navigation.group: Decisions and output
icon: i-lucide-message-circle-more
---

`progressSummary()` observes reasoning and tool lifecycle events while an Agent works, then emits a replaceable one-sentence status as transient `data-progress-summary` stream data.

## Add progress summaries

Import the Capability from `@vite-hub/agent/capabilities` and give it the independent Agent Driver that writes progress:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { progressSummary } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: primaryDriver,
  capabilities: [
    progressSummary({
      driver: {
        kind: 'codex',
        model: 'gpt-5.6-luna',
      },
    }),
  ],
})
```

The Capability owns the safety and evidence instructions. The configured Driver selects the model and execution environment using the same contract as an Agent Definition or `title()`. Use `guidance` to append product-specific direction without replacing those safeguards.

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

With manual chat delivery, ViteHub edits the current placeholder as summaries arrive. When the Agent finishes, ViteHub deletes that placeholder and posts the final reply as a new message so chat platforms can deliver their normal notification.

## Understand the runtime behavior

With event-driven `intervalMs: 0`, the Capability starts its initial summary when the first non-terminal primary stream chunk arrives. A terminal-only or failed stream does not start unused auxiliary work.

Positive intervals begin when the first primary stream chunk arrives and use a fixed cadence from that point, so auxiliary generation never delays primary Driver startup. At most one generation runs at a time, and interval ticks are skipped while a generation is pending. Set `intervalMs: 0` to generate from reasoning and tool activity through the event-driven microtask behavior instead. Activity that arrives during an event-driven generation schedules one follow-up after it settles. Raw reasoning, tool input, and tool output are excluded from the generated prompt; reasoning is represented only as a boolean presence signal.

The default prompt includes the latest user request with trusted `<context>` payloads removed, elapsed time, reasoning presence, sanitized tool names, and the previous summary. The request identifies the subject and language; the summarizer instructions explicitly treat it as untrusted data. The prompt does not include raw reasoning, tool input, tool output, or hidden instructions.

The Capability stops its cadence and aborts every in-flight generation when the parent invocation aborts or the primary stream finishes, cancels, or errors. A generation failure does not interrupt the primary response stream; ViteHub emits a sanitized warning and trace event without logging the Driver error message.

## Requirements

The primary Agent Driver must expose a compatible async stream or UI message stream. With a positive interval, the Capability attempts a summary on every tick and suppresses unchanged output. With `intervalMs: 0`, it remains silent after the first-chunk summary until reasoning or tool lifecycle events provide new activity.

Configure a `driver`, `model`, or `execute` option for summary generation. Without one of those options, the Capability uses the Agent model when available.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses an explicit summary model or the Agent model. |
| Provider-backed | Uses an independent Agent Driver, including its model and environment settings. |
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
| `guidance` | `string` | none | Product-specific direction appended to the Capability-owned instructions. |
| `intervalMs` | `number` | `10000` | Fixed generation cadence. Use `0` for event-driven updates. |
| `maxLength` | `number` | `180` | Maximum summary length. |
| `model` | `AgentModelResolver` | Agent model | Model used when no independent Driver is configured. |
| `template` | `string \| function` | generated | Markdown prompt template. |
| `variables` | `Record<string, value \| function>` | none | Extra Markdown template variables. |

String templates use `@vite-hub/markdown-template` and receive `userText`, `elapsed`, `reasoningActive`, `activeTools`, `completedTools`, and `previous`. Function templates additionally receive `elapsedText` plus the structured snapshot fields. Keep sensitive content out of prompts you construct.

## Related pages

- [title()](/docs/capabilities/title)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Markdown pages](/docs/ai-resources/markdown-pages)
