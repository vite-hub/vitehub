---
title: Channels capability
description: Let an Agent send its result through a Channel to a recipient that your app picks.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-send
---

`channelDelivery()` is a Capability: it gives an Agent one tool, `send_message` by default. The tool sends a message through a [Channel](/docs/channels/server-api) client to a recipient that your app picks. The model only writes the message.

Use it when an Agent run (an Invocation) must deliver its result somewhere other than where it started, such as a Schedule that sends a report to a Teams user.

## Configure Channel delivery

Pass the Channel client from `useChannel()` and the send options. Set `required` when the Agent Invocation must fail without a successful send. The examples on this page send through this `teams` Channel, which posts to a Microsoft Teams chat through your own relay:

```ts [server/channels/teams.ts]
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({
  adapter: {
    kind: 'teams',
    async send(text: string, options: { recipient: string }) {
      const response = await fetch('https://teams-relay.example.com/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: options.recipient, text }),
      })
      if (!response.ok) throw new Error(`Teams answered ${response.status}`)
      return { id: response.headers.get('x-message-id') ?? crypto.randomUUID() }
    },
  },
})
```

The Schedule extends this `bot` Agent:

```ts [server/agents/bot/agent.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Write short reports from the data in the prompt.',
  },
})
```

```ts [server/schedules/weekly-report.ts]
import { defineSchedule } from 'vite-hub/schedule'
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
    const [error] = await runAgent(reportAgent, { prompt: 'Write the weekly report.' }, { schedule })
    if (error) throw error
    return new Response('Report sent')
  },
})
```

Capabilities attach through the Agent Definition, so the Schedule extends the Agent. `tools` passed to `runAgent()` can run next to the Capability.

## Select the recipient per Agent Invocation

`options` can be a function of the Capability context. It runs once per Invocation, before the Driver (the part that runs the model), and can return a promise. Use it when the Invocation input picks the recipient:

```ts [server/agents/thread-reply.ts]
import { defineAgent } from 'vite-hub/agent'
import { channelDelivery } from 'vite-hub/agent/capabilities'
import { useChannel } from 'vite-hub/channels/server'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    channelDelivery({
      channel: useChannel('teams'),
      options(context) {
        const thread = context.invocation.input.get().context?.thread
        if (typeof thread !== 'string') throw new Error('Send a thread ID in the invocation context.')
        return { recipient: thread }
      },
    }),
  ],
})
```

- A throw or rejection fails the Invocation with `CHANNEL_DELIVERY_OPTIONS` before the Driver runs. The error is the `cause`. The model never sees it, and no send attempt counts.
- It also runs in a dry run, which then shows the same error. Keep it free of side effects.
- All sends in one Invocation use these options.

## Act after each delivery

`onDelivered(message, receipt, context)` runs after each successful send, also in a dry run. `message` is the model's message. `receipt` is `{ deliveryId, dryRun, text }`, where `text` is the text after `format`. Use it to record what was sent:

```ts [server/agents/logged-report.ts]
import { defineAgent } from 'vite-hub/agent'
import { channelDelivery } from 'vite-hub/agent/capabilities'
import { useChannel } from 'vite-hub/channels/server'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    channelDelivery({
      channel: useChannel('teams'),
      options: { recipient: 'user:7b0bff9d' },
      onDelivered(message, receipt) {
        console.info(`Sent ${receipt.deliveryId}${receipt.dryRun ? ' (dry run)' : ''}: ${receipt.text.length} characters`)
      },
    }),
  ],
})
```

- One Agent Definition serves many Invocations. Keep `onDelivered` state per Invocation, not in a shared module variable.
- The tool waits for `onDelivered` before it returns the receipt. The delivery Trace Event is recorded first.
- When `onDelivered` throws, the delivery still counts for `required` and the model gets the receipt, so it does not resend. The Invocation then fails with `CHANNEL_DELIVERY_HOOK_FAILED` at the end, with `deliveryId`, `dryRun`, and `tool` in `details` and the error as `cause`. Only the first error is kept.

## Agent-visible tool contract

The tool takes one field, `message`, a non-empty string. On success, it returns `{ deliveryId, sent: true }`. Without `description`, the tool description names the Channel and how many calls are allowed.

## How Channel delivery works

- The tool trims the message. `validate` can throw to reject it. The model gets the error and can retry. A rejected message does not count as a call.
- `format` builds the Channel text from the message. It gets the Capability context, so it can read the Invocation input. A `format` failure or empty text does not count as a send attempt.
- The tool calls `channel.send(text, options)`. A send error goes to the model.
- In a dry run, it skips `channel.send()`, records a Trace Event, and returns a `dry-run:<uuid>` delivery ID.
- It counts each attempt before it sends. After `maxCalls` attempts, it returns `CHANNEL_DELIVERY_LIMIT` before `validate` or `format`. A failed send also counts, because it can still reach the recipient.
- With `required: true`, the Invocation fails with `CHANNEL_DELIVERY_REQUIRED` when the Agent ends without a successful send, also when an input Capability handles it before the Driver runs, in any order. Streams and `Response` bodies are checked when they end normally. After another error or a cancel, delivery is not required.
- Counters are per Invocation.
- The tool name must be unique among Capability tools. A clash fails setup with `CHANNEL_DELIVERY_TOOL_CONFLICT` before the Driver runs.

## Remind the Agent to send

Models sometimes end with the answer as final text and never call the tool. With `required: true`, set `reminder` to run the Driver again before the Invocation fails:

```ts [server/agents/reminded-report.ts]
import { defineAgent } from 'vite-hub/agent'
import { channelDelivery } from 'vite-hub/agent/capabilities'
import { useChannel } from 'vite-hub/channels/server'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    channelDelivery({
      channel: useChannel('teams'),
      options: { recipient: 'user:7b0bff9d' },
      required: true,
      reminder: { turns: 1, instruction: 'Send the finished report with send_message now.' },
    }),
  ],
})
```

`reminder: true` is one turn with the default instruction. A reminder turn:

- Runs only when the Agent finished without calling the tool. Any send attempt, even a failed one, means no reminder, because a failed send can still reach the recipient.
- Runs in the same Invocation, with the same tools and counters. `maxCalls` limits attempts across all turns. `turns` limits reminder turns.
- Gives the Driver the original messages, the last final text as an assistant message, and the instruction as a user message. Later turns add to this transcript.
- Does not replay earlier tool calls. A Driver that resumes its session sees them; others see only the final text, so the reminder asks the Agent to send it, not redo the work.
- For a stream, UI message stream, or `Response`, runs after the caller reads it and its tools finish.
- When all turns end without a successful send, the Invocation fails with `CHANNEL_DELIVERY_REQUIRED`. `details` has `attempts` and `reminders`.
- Emits an `agent.channel.delivery.reminder` Trace Event with the turn number, tool name, length of the previous final text, and previous token usage when the Driver reports it.
- The finish usage record covers only the last turn. Earlier turns are in the reminder Trace Events.

| Agent Driver | Reminder turn |
| --- | --- |
| Model-backed | A new model call with the transcript. |
| Provider-backed | Resumes the provider session when the Invocation has a thread or chat session that the provider keeps. Else starts a new session with the transcript as the prompt. |
| Custom-run-backed | `driver.run` runs again with the transcript in `context.messages` and `context.input.prompt`. Streams and `Response` results are checked after they settle. |

## Requirements

- A Channel client with `send(text, options)` that returns `[error, undefined]` or `[undefined, { deliveryId }]`. `useChannel(name)` from `vite-hub/channels/server` returns one.
- `maxCalls` must be a positive integer.
- `reminder` needs `required: true`. `reminder.turns` must be a positive integer, and `reminder.instruction` a non-empty string.
- When the Agent Definition loads, `channelDelivery()` throws a `TypeError` if `channel` has no `send()`, or `maxCalls` or `reminder` is invalid.

## Security and approval

- The model controls only `message`. Your app fixes the Channel and `options`, such as the recipient. An `options` function reads the Invocation input, so trust it only when you trust the caller.
- The message text leaves your app through the Channel provider.
- `validate` and `format` are your checks on the message. `maxCalls` limits send attempts per Invocation.
- `channelDelivery()` has no `policy` option. A valid call sends at once, without approval.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets the tool. |
| Provider-backed | Gets the tool through the provider MCP bridge. |
| Custom-run-backed | `driver.run` gets the tool in `context.tools` and decides whether to call it. |

## Verify Channel delivery

1. When the Capability is on a discovered Agent, start the Vite dev server.
2. Run `vitehub agent info --agent <name> --json`. Check that `tools` has `name: "send_message"`, and `capabilities` has `{ id: "channel-delivery.send_message" }` with the expected `channel`, `maxCalls`, `required`, and `reminder`.
3. Run the Agent with a test recipient. Check that the tool result has a `deliveryId` and the message arrives.
4. With `required: true`, use a prompt that does not ask for a send. Check that the Invocation fails with `CHANNEL_DELIVERY_REQUIRED`.
5. With `reminder`, run the same prompt. Check for one `agent.channel.delivery.reminder` Trace Event per reminder turn. When no send follows, `details.reminders` must match the turns that ran.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channel` | `{ name?: string, send(text, options) }` | required | The Channel client, for example `useChannel('teams')`. |
| `options` | send options \| `(context) => options \| Promise<options>` | required | Options for `send()`, such as the recipient. The model cannot change them. A function runs once per Invocation ([Select the recipient per Agent Invocation](#select-the-recipient-per-agent-invocation)). |
| `name` | `string` | `"send_message"` | Tool name. The Capability ID is `channel-delivery.<name>`. |
| `description` | `string` | generated | Tool description for the model. |
| `required` | `boolean` | `false` | Fail the Invocation without a successful send. |
| `reminder` | `boolean \| { turns?: number, instruction?: string }` | none | With `required: true`, run up to `turns` (default `1`) reminder turns when the Agent ends without calling the tool ([Remind the Agent to send](#remind-the-agent-to-send)). |
| `maxCalls` | `number` | `1` | Maximum send attempts per Invocation, across all turns. |
| `format` | `(message, context) => string \| Promise<string>` | none | Builds the Channel text from the message. |
| `validate` | `(message) => void \| Promise<void>` | none | Throw to reject a message. |
| `onDelivered` | `(message, receipt, context) => void \| Promise<void>` | none | Runs after each successful or dry-run send ([Act after each delivery](#act-after-each-delivery)). |

## Related pages

- [Agent Channels](/docs/agents/channels)
- [Channels Server Primitive](/docs/channels)
- [Schedule primitive](/docs/schedule)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Official capabilities](/docs/agents/capabilities/official)
