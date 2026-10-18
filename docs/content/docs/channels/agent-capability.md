---
title: Channels capability
description: Let an Agent send its result through a Channel to a recipient that the application selects.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-send
---

`channelDelivery()` gives an Agent one tool, `send_message` by default. The tool sends a message through a [Channel](/docs/channels/server-api) client to a recipient that the application selects. The model only writes the message.

Use it when an Agent Invocation must deliver its result somewhere other than the Channel that started it. Examples are a Schedule that sends a report to a Teams user, or a webhook Agent that sends a draft to a reviewer.

## Configure Channel delivery

Pass the Channel client from `useChannel()` and the send options. Set `required` when the Agent Invocation must fail without a successful send:

```ts [server/schedules/weekly-report.ts]
import { defineSchedule } from '@vite-hub/schedule'
import { defineAgent, runAgent } from 'vite-hub/agent'
import { channelDelivery } from 'vite-hub/agent/capabilities'
import { useChannel } from 'vite-hub/channels/server'
import bot from '../agents/bot/agent'

const reportAgent = defineAgent({
  extends: bot,
  name: 'weekly-report',
  capabilities: [
    channelDelivery({
      channel: useChannel('teams'),
      options: { recipient: 'user:7b0bff9d' },
      description: 'Send the finished weekly report. Call once.',
      required: true,
      reminder: true,
      validate: (message) => {
        if (message.split(/\s+/u).length > 300) throw new Error('The report must be at most 300 words.')
      },
    }),
  ],
})

export default defineSchedule({
  cron: '0 15 * * 5',
  handler: async (schedule) => {
    const [error] = await runAgent(reportAgent, { prompt: 'Write the weekly report.' }, { schedule, output: 'drained' })
    if (error) throw error
    return new Response('Report sent')
  },
})
```

Capabilities attach through the Agent Definition, so the Schedule extends the Agent. Invocation `tools` passed to `runAgent()` can run next to the Capability.

## Select the recipient per Agent Invocation

`options` can be a function of the Capability context. It runs once per Agent Invocation, before the Driver runs, and can return a promise. Use it when one Agent Definition sends to a recipient that the Agent Invocation input selects:

```ts
channelDelivery({
  channel: useChannel('teams'),
  options(context) {
    const thread = context.invocation.input.get().context?.thread
    if (typeof thread !== 'string') throw new Error('Send a thread ID in the invocation context.')
    return { recipient: thread }
  },
})
```

- A throw or a rejected promise fails the Agent Invocation with `CHANNEL_DELIVERY_OPTIONS` before the Driver runs. The original error is the `cause`. The model never sees it, and no send attempt is counted.
- The function also runs in a dry run, so a dry run shows the same configuration error as a real run. Keep it free of side effects.
- All sends in one Agent Invocation use the resolved options.

## Act after each delivery

`onDelivered(message, receipt, context)` runs after each successful send and after each send that a dry run records. `message` is the model's message. `receipt` is `{ deliveryId, dryRun, text }`, where `text` is the Channel text after `format`. Use it to record what was sent:

```ts
channelDelivery({
  channel: useChannel('teams'),
  options: { recipient: 'user:7b0bff9d' },
  onDelivered(message, receipt) {
    console.info(`Sent ${receipt.deliveryId}${receipt.dryRun ? ' (dry run)' : ''}: ${receipt.text.length} characters`)
  },
})
```

- One Agent Definition serves many Agent Invocations. Keep state from `onDelivered` per Agent Invocation, not in a shared module variable.

- The tool waits for `onDelivered` before it returns the receipt to the model. The delivery Trace Event is recorded before `onDelivered` runs.
- When `onDelivered` throws, the delivery still counts. It satisfies `required`, and the model still receives the receipt, so it does not send the message again. The Agent Invocation then fails with `CHANNEL_DELIVERY_HOOK_FAILED` when it finishes. The error `details` include `deliveryId`, `dryRun`, and `tool`, and the original error is the `cause`. When several calls fail, the first error is kept.

## Agent-visible tool contract

The tool accepts one field, `message`, a non-empty string. On success, it returns `{ deliveryId, sent: true }`.
Without `description`, the tool description names the Channel and states how many times the Agent can call the tool.

## How Channel delivery works

- The tool trims the message. `validate` can throw to reject it. The model receives the error and can retry. A rejected message does not count as a call.
- `format` builds the Channel text from the message. It receives the Capability context, so it can read the Agent Invocation input context. A formatter failure, or formatted text that is empty, does not count as a send attempt.
- The tool calls `channel.send(text, options)`. A send error is thrown to the model.
- In a dry run, the tool does not call `channel.send()`. It records the delivery as a Trace Event and returns a `dry-run:<uuid>` delivery ID.
- The tool counts each send attempt before it sends. After `maxCalls` attempts, the tool returns `CHANNEL_DELIVERY_LIMIT` before validation or formatting. A failed send also counts, because it can still reach the recipient.
- With `required: true`, the Agent Invocation fails with `CHANNEL_DELIVERY_REQUIRED` when the Agent finishes without a successful send. The requirement also applies when an input Capability handles the Agent Invocation before the Driver runs, regardless of Capability order. Streams and `Response` bodies are checked when they finish normally. When the Agent Invocation fails with another error or is cancelled, delivery is not required.
- Counters are per Agent Invocation. One definition can serve many Agent Invocations.
- The delivery tool name must be unique among Capability tools. A collision fails setup with `CHANNEL_DELIVERY_TOOL_CONFLICT` before the Driver runs.

## Remind the Agent to send

Models sometimes finish with the answer as their final text and never call the tool. With `required: true`, set `reminder` to run the Driver again before the Agent Invocation fails:

```ts
channelDelivery({
  channel: useChannel('teams'),
  options: { recipient: 'user:7b0bff9d' },
  required: true,
  reminder: { turns: 1, instruction: 'Send the finished report with send_message now.' },
})
```

`reminder: true` is one turn with the default instruction. A reminder turn works like this:

- It runs only when the Agent finished without calling the tool. After any send attempt, including a failed one, there is no reminder, because a failed send can still reach the recipient.
- It runs in the same Agent Invocation, with the same tools and counters. `maxCalls` still limits send attempts across all turns. `turns` limits reminder turns.
- The Driver receives the original messages, the previous final text as an assistant message, and the instruction as a user message. Each further turn appends to that transcript.
- The previous turn's tool calls and tool results are not replayed. A Driver that resumes its own session sees them. Other Drivers see only the final text, so the reminder asks the Agent to send that text instead of repeating the work.
- For streamed results, the reminder check runs after the stream has been consumed and its tools have finished. A stream, UI message stream, or `Response` therefore receives its configured reminder after the caller reads it and the stream settles.
- When all turns finish without a successful send, the Agent Invocation fails with `CHANNEL_DELIVERY_REQUIRED`. The error `details` include `attempts` and `reminders`.
- Each turn emits an `agent.channel.delivery.reminder` Trace Event with the turn number, the tool name, the length of the previous final text, and the previous turn's token usage when the Driver reports it.
- The finish usage record covers the last turn only. Earlier turns are in the reminder Trace Events.

| Agent Driver | Reminder turn |
| --- | --- |
| Model-backed | A new model call with the transcript. |
| Provider-backed | Resumes the provider session when the Agent Invocation has a thread or chat session that the provider keeps. Otherwise it starts a new provider session with the transcript as the prompt. |
| Custom-run-backed | `driver.run` runs again with the transcript in `context.messages` and `context.input.prompt`. Stream and `Response` results are checked after they settle. |

## Requirements

- A Channel client with `send(text, options)` that returns `[error, null]` or `[null, { deliveryId }]`. `useChannel(name)` from `vite-hub/channels/server` returns one.
- `maxCalls` must be a positive integer.
- `reminder` requires `required: true`. `reminder.turns` must be a positive integer, and `reminder.instruction` must be a non-empty string.
- `channelDelivery()` throws a `TypeError` when the Agent Definition loads if `channel` has no `send()` function, or if `maxCalls` or `reminder` is invalid.

## Security and approval

- The model controls only `message`. The application fixes the Channel and the send `options`, such as the recipient. The model cannot change them. An `options` function reads the Agent Invocation input, so treat that input as trusted only when the caller is trusted.
- The message text leaves the application through the Channel provider.
- `validate` and `format` are the application checks on the message. `maxCalls` limits the number of send attempts for each Agent Invocation.
- `channelDelivery()` has no `policy` option. A valid call sends at once, without approval.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the delivery tool. |
| Provider-backed | Receives the delivery tool through the provider MCP bridge. |
| Custom-run-backed | `driver.run` receives the delivery tool in `context.tools` and decides whether to call it. |

## Verify Channel delivery

1. When the Capability is on a discovered Agent, start the Vite development server.
2. Run `vitehub agent info --agent <name> --json`. Confirm that `tools` contains an entry with `name: "send_message"`, and that `capabilities` contains `{ id: "channel-delivery.send_message" }` with the expected `channel`, `maxCalls`, `required`, and `reminder` metadata.
3. Run the Agent with a test recipient. Confirm that the tool result contains a `deliveryId` and that the message arrives in the Channel.
4. With `required: true`, run the Agent with a prompt that does not ask for a send. Confirm that the Agent Invocation fails with `CHANNEL_DELIVERY_REQUIRED`.
5. With `reminder`, run the same prompt. Confirm an `agent.channel.delivery.reminder` Trace Event for each reminder turn, and that the error `details.reminders` matches the turns that ran when no send follows.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channel` | `{ name?: string, send(text, options) }` | required | The Channel client, for example `useChannel('teams')`. |
| `options` | send options \| `(context) => options \| Promise<options>` | required | Options passed to `send()`, such as the recipient. The model cannot change them. A function resolves them once per Agent Invocation. See [Select the recipient per Agent Invocation](#select-the-recipient-per-agent-invocation). |
| `name` | `string` | `"send_message"` | Tool name. The Capability ID is `channel-delivery.<name>`. |
| `description` | `string` | generated | Tool description for the model. |
| `required` | `boolean` | `false` | Fail the Agent Invocation without a successful send. |
| `reminder` | `boolean \| { turns?: number, instruction?: string }` | none | With `required: true`, run up to `turns` (default `1`) reminder turns when the Agent finishes without calling the tool. See [Remind the Agent to send](#remind-the-agent-to-send). |
| `maxCalls` | `number` | `1` | Maximum send attempts per Agent Invocation, across all turns. |
| `format` | `(message, context) => string \| Promise<string>` | none | Build the Channel text from the message. |
| `validate` | `(message) => void \| Promise<void>` | none | Throw to reject a message. |
| `onDelivered` | `(message, receipt, context) => void \| Promise<void>` | none | Runs after each successful or dry-run send. See [Act after each delivery](#act-after-each-delivery). |

## Related pages

- [Agent Channels](/docs/agents/channels)
- [Channels Server Primitive](/docs/channels)
- [Schedule primitive](/docs/schedule)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Official capabilities](/docs/agents/capabilities/official)
