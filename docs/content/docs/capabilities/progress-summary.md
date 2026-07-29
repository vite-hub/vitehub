---
title: Progress summary
description: Stream a short user-facing summary of current Agent activity.
navigation.title: Progress summary
navigation.order: 210
navigation.group: Decisions and output
icon: i-lucide-message-circle-more
---

`progressSummary()` observes reasoning and tool lifecycle events while an Agent works, then emits a replaceable one-sentence status as transient `data-progress-summary` stream data.

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

## Understand the runtime behavior

The Capability generates an initial summary when the stream starts. Reasoning deltas and tool start or completion events then mark the current activity dirty. While new activity exists, the Capability generates at most one summary per interval and never overlaps generations. Raw reasoning, tool input, and tool output are excluded from the generated prompt; reasoning is represented only as an `Active` presence signal.

The default prompt uses only reasoning presence, sanitized tool names, and the previous summary. It does not include user message text, code, commands, paths, traces, hidden instructions, credentials, raw tool details, or trusted `<context>` payloads.

The Capability stops pending timers when the parent invocation aborts. It also discards pending or in-flight summaries when the primary stream finishes, so progress never delays completion or arrives after terminal output. A generation failure does not interrupt the primary response stream.

## Requirements

The primary Agent Driver must expose a compatible async stream or UI message stream. After the initial summary, the Capability remains silent until reasoning or tool lifecycle events provide new activity to summarize.

Configure a `driver`, `model`, or `execute` option for summary generation. Without one of those options, the Capability uses the Agent model when available.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses an explicit summary model or the Agent model. |
| Harness-backed | Uses an independent Harness Driver, including its model and reasoning settings. |
| Custom-run-backed | Uses an independent custom Driver or the `execute` callback. |

## Verify the result

Run an invocation and confirm that the primary stream continues immediately while an initial transient `data-progress-summary` part arrives. Perform at least one tool call or emit reasoning for longer than `intervalMs`, then confirm that a later part arrives with a higher `revision`.

Stop the invocation before the next interval and confirm that no later progress part appears.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `AgentDriver` | none | Independent Agent Driver used for progress generation. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom progress generator. |
| `id` | `string` | `"progress-summary"` | Capability id. |
| `instructions` | `string` | Capability-owned instructions | System instructions for model-backed generation. |
| `intervalMs` | `number` | `10000` | Minimum delay between dirty progress snapshots. |
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
