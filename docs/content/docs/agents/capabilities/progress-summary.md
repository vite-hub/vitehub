---
title: Progress summary
description: Stream a short user-facing summary of current Agent activity.
navigation.title: Progress summary
navigation.order: 311
navigation.group: Capabilities
icon: i-lucide-message-circle-more
---

`progressSummary()` observes reasoning and tool lifecycle events while an Agent works, then emits a replaceable one-sentence status as transient `data-progress-summary` stream data.
It adds no model-facing tool. A separate generator writes the status: an independent Agent Driver, an AI SDK model call, or a custom `execute()` function. No Server Primitive is involved.

## Configure progress summaries

Import the Capability from `vite-hub/agent/capabilities` and give it the independent Agent Driver that writes progress:

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

## How progress summaries work

The Capability wraps the primary output stream and observes its chunks. It tracks reasoning presence, active tools, and the last 5 completed tools.

With the default `intervalMs` of `10000`, generation starts when the first primary stream chunk arrives and then runs on a fixed cadence from that point, so auxiliary generation never delays primary Driver startup. At most one generation runs at a time, and interval ticks are skipped while a generation is pending. Each tick attempts a summary and suppresses unchanged output.

With event-driven `intervalMs: 0`, the Capability starts its initial summary when the first non-terminal primary stream chunk arrives. A terminal-only or failed stream does not start unused auxiliary work. After the first summary, it generates again only when reasoning or tool lifecycle events add new activity. Activity that arrives during a generation schedules one follow-up after it settles.

The default prompt includes the latest user request with `<context>` payloads removed (up to 2,000 characters), elapsed time, reasoning presence, sanitized tool names, and the previous summary. The request identifies the subject and language; the summarizer instructions treat it as untrusted data. The prompt does not include raw reasoning, tool input, tool output, or hidden instructions.

ViteHub cleans the result, bounds it by `maxLength`, and ends a cut summary with `…`.

The Capability stops its cadence and aborts every in-flight generation when the parent invocation aborts or the primary stream finishes, cancels, or errors. A generation failure does not interrupt the primary response stream; ViteHub emits a sanitized warning and an `agent.progress-summary.error` trace event without logging the Driver error message.

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

`data.id` is present when you set the `id` option.
The part is transient, so it does not become conversation history. Keep structured reasoning and tool logs separate when your interface exposes them.

## Channel placeholders

With `messages.loading` or manual chat delivery, ViteHub edits the current placeholder as summaries arrive. When the Agent finishes, ViteHub deletes that placeholder and posts the final reply as a new message so chat platforms can deliver their normal notification.

## Prompt templates

String templates use `@vite-hub/markdown-template` and receive their values under the `data` namespace: `data.userText`, `data.elapsed`, `data.reasoningActive`, `data.reasoningActiveText`, `data.activeTools`, `data.completedTools`, and `data.previous`. Extra variables are available as `data.<variable>`.

Function templates receive the structured snapshot fields, `input`, `messages`, `elapsedText`, `activeToolsText`, and `completedToolsText`. Keep sensitive content out of prompts you construct.

## Requirements

- The primary Agent Driver must return a compatible async stream or UI message stream.
- A generator: `driver`, `model`, or `execute`. Without one of these options, the Capability uses the Agent model, which only model-backed Agents have. With no generator, no summaries appear.
- A progress `driver` must return text. `driver.ask` is not supported.
- A provider `driver` needs a Node.js host. A Cloudflare Worker build fails with `AGENT_B0019`.

## Security and approval

`progressSummary()` adds no model-facing tool and has no `policy` option.
The default prompt sends the latest user request, elapsed time, reasoning presence, sanitized tool names, and the previous summary to the generator. It does not send raw reasoning, tool input, or tool output.

`execute` and function templates receive the full Agent Run Input and messages. Code in those functions controls what it sends.
An independent provider `driver` runs with its own configuration, credentials, and permissions, not the primary Driver's.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses `driver`, `model`, `execute`, or the Agent model. |
| Provider-backed | Requires `driver`, `model`, or `execute`. An independent provider Driver uses its own model and environment settings. |
| Custom-run-backed | Requires `driver`, `model`, or `execute`. The output must be a compatible stream. |

## Verify progress summaries

1. Run an invocation and confirm that the primary stream continues immediately while an initial transient `data-progress-summary` part arrives.
2. Keep the invocation open beyond `intervalMs`, then confirm that a later changed summary arrives with a higher `revision`.
3. Stop the invocation before the next interval and confirm that no later progress part appears.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `AgentDriver` | none | Independent Agent Driver used for progress generation. Must return text. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom progress generator. |
| `guidance` | `string` | none | Product-specific direction appended to the Capability-owned instructions. |
| `id` | `string` | `"progress-summary"` | Capability id. When set, also sent as `data.id` in each part. |
| `intervalMs` | `number` | `10000` | Fixed generation cadence. Use `0` for event-driven updates. |
| `maxLength` | `number` | `180` | Maximum summary length. |
| `model` | `AgentModelResolver` | Agent model | Model used when no independent Driver is configured. |
| `template` | `string \| function` | generated | Markdown prompt template. |
| `variables` | `Record<string, value \| function>` | none | Extra Markdown template variables. |

## Related pages

- [title()](/docs/agents/capabilities/title)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Channels](/docs/agents/channels)
- [Markdown templates](/docs/reference/markdown-templates)
- [Markdown pages](/docs/getting-started/ai-resources/markdown-pages)
- [Official Capabilities](/docs/agents/capabilities/official)
