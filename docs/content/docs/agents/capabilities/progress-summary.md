---
title: Progress summary
description: Show users one short sentence about what the Agent is doing now, in your UI and in chat Channels.
navigation.title: Progress summary
navigation.order: 311
navigation.group: Capabilities
icon: i-lucide-message-circle-more
---

`progressSummary()` tells users in one sentence what the Agent is doing. It watches reasoning and tool events and sends the status as transient `data-progress-summary` stream data, not saved in the conversation. Each sentence replaces the last.

A separate generator writes it: an independent Agent Driver (a second Driver), an AI SDK model call, or your `execute()`. It adds no model tool and uses no Server Primitive.

## Configure progress summaries

Give it the independent Driver that writes the sentences:

```ts [server/agents/support.ts] fragment
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { progressSummary } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: primaryDriver,
  capabilities: [
    progressSummary({
      driver: codexDriver({
        model: 'gpt-5.6-luna',
      }),
    }),
  ],
})
```

The Capability writes its own safety and evidence instructions. The Driver picks the model and environment, like the `driver` of an Agent Definition or `title()`. `guidance` adds product directions without replacing the safety instructions.

## How progress summaries work

The Capability wraps the primary output stream (the main answer) and tracks reasoning, active tools, and the last 5 finished tools.

- **Fixed interval** (default, `intervalMs: 10000`). Generation starts at the first primary chunk, then repeats on the interval, so it never delays the primary Driver. One generation runs at a time; ticks during one are skipped. Unchanged summaries are not resent.
- **Event-driven** (`intervalMs: 0`). The first summary starts at the first non-final primary chunk; a stream with only a final chunk, or that fails, starts nothing. Later summaries start only when reasoning or tool events add activity. Activity during a generation queues one more after it.

The default prompt has the latest user request without `<context>` content (up to 2,000 characters), elapsed time, whether the Agent is reasoning, tool names with unsafe text removed, and the previous summary. The request gives subject and language and is treated as untrusted data. Raw reasoning, tool input and output, and hidden instructions are never included.

The result is cleaned and cut to `maxLength`, ending with `…` when cut.

The interval stops and generations are cancelled when the parent run is cancelled or the primary stream finishes, is cancelled, or fails.

A failed generation does not stop the primary stream. ViteHub sends a safe warning and an `agent.progress-summary.error` trace event, without logging the Driver error message.

## Render the current summary

Listen for `data-progress-summary` parts and replace the sentence when `revision` increases:

```ts fragment
{
  type: 'data-progress-summary',
  data: {
    type: 'progress-summary',
    summary: 'Checking current SKU costs against the planning data.',
    revision: 1,
  },
}
```

`data.id` is present when `id` is set. The part is transient, so it stays out of history. Keep reasoning and tool logs separate from this sentence.

## Channel placeholders

With `messages.loading` or manual chat delivery, ViteHub edits the Channel placeholder with each summary. At the end it deletes the placeholder and posts the final reply as a new message, so the platform sends its normal notification.

## Prompt templates

`template` sets your own prompt.

String templates use `@vite-hub/markdown-template` with `data.userText`, `data.elapsed`, `data.reasoningActive`, `data.reasoningActiveText`, `data.activeTools`, `data.completedTools`, `data.previous`, and your `variables` as `data.<variable>`.

Function templates get the snapshot fields, `input`, `messages`, `elapsedText`, `activeToolsText`, and `completedToolsText`. Keep sensitive content out of them.

## Requirements

- The primary Driver returns a compatible async or UI message stream.
- A generator: `driver`, `model`, or `execute`, else the Agent's model, which only model-backed Agents have. Without one, no summaries appear.
- A progress `driver` returns text. `driver.ask` is not supported.
- A provider `driver` needs a Node.js host. Cloudflare Worker builds fail with `AGENT_B0019`.

## Security and approval

There is no model tool and no `policy` option. The default prompt sends only the fields listed above, never raw reasoning or tool input and output.

> [!WARNING]
> `execute` and function templates get the full Agent Run Input and messages. Your code decides what they send.

An independent provider `driver` uses its own configuration, credentials, and permissions, not the primary Driver's.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses `driver`, `model`, `execute`, or the Agent model. |
| Provider-backed | Requires `driver`, `model`, or `execute`. An independent provider Driver uses its own settings. |
| Custom-run-backed | Requires `driver`, `model`, or `execute`. The output must be a compatible stream. |

## Verify progress summaries

1. Run the Agent. The primary stream continues at once while a first `data-progress-summary` arrives.
2. Past `intervalMs`, a changed summary arrives with a higher `revision`.
3. Stopped before the next interval, no more parts appear.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `AgentDriver` | none | Independent Driver for summaries. Returns text. |
| `execute` | `(input) => string \| { summary?: string }` | none | Custom progress generator. |
| `guidance` | `string` | none | Product direction added to the built-in instructions. |
| `id` | `string` | `"progress-summary"` | Capability id. When set, also sent as `data.id`. |
| `intervalMs` | `number` | `10000` | Fixed cadence. `0` is event-driven. |
| `maxLength` | `number` | `180` | Maximum summary length. |
| `model` | `AgentModelResolver` | Agent model | Model when no Driver is set. |
| `template` | `string \| function` | generated | Markdown prompt template. |
| `variables` | `Record<string, value \| function>` | none | Extra Markdown template variables. |

## Related pages

- [title()](/docs/agents/capabilities/title)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Channels](/docs/agents/channels)
- [Markdown templates](/docs/markdown-template)
- [Markdown pages](/docs/getting-started/ai-resources/markdown-pages)
- [Official Capabilities](/docs/agents/capabilities/official)
