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
import { codexDriver } from '@vite-hub/agent/harness/codex'

export default defineAgent({
  driver: primaryDriver,
  capabilities: [
    progressSummary({
      driver: codexDriver({
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
      }),
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

Reasoning deltas and tool start or completion events mark the current activity dirty. While new activity exists, the Capability generates at most one summary per interval and never overlaps generations. Raw reasoning, tool input, and tool output are excluded from the generated prompt; reasoning is represented only as an `Active` presence signal.

The default prompt preserves useful product concepts and names while translating internal tool identifiers into their purpose. It omits code, commands, paths, traces, hidden instructions, credentials, and raw tool details. Trusted `<context>` payloads embedded in user messages are also excluded.

The Capability stops pending timers when the parent invocation aborts. It also discards pending or in-flight summaries when the primary stream finishes, so progress never delays completion or arrives after terminal output. A generation failure does not interrupt the primary response stream.

## Requirements

The primary Agent Driver must emit reasoning or tool lifecycle events through a compatible async stream or UI message stream. The Capability remains silent when the stream has no new activity to summarize.

Configure a `driver`, `model`, or `execute` option for summary generation. Without one of those options, the Capability uses the Agent model when available.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses an explicit summary model or the Agent model. |
| Harness-backed | Uses an independent Harness Driver, including its model and reasoning settings. |
| Custom-run-backed | Uses an independent custom Driver or the `execute` callback. |

## Verify the result

Run an invocation that performs at least one tool call or emits reasoning for longer than `intervalMs`. Confirm that the primary stream continues immediately and that a transient `data-progress-summary` part arrives with a higher `revision`.

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

String templates use `@vite-hub/markdown-template` and receive `userText`, the `reasoning` presence signal, `activeTools`, `completedTools`, and `previous`.

## Reference

- [title()](/docs/capabilities/title)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Markdown pages](/docs/ai-resources/markdown-pages)
- Source: `packages/agent/src/capabilities/progress-summary.ts`
