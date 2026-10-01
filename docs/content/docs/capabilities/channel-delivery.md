---
title: Channel delivery
description: Let an Agent send its result through a Channel to a recipient that the application selects.
navigation.title: Channel delivery
navigation.order: 97
navigation.group: Runtime primitives
icon: i-lucide-send
---

`channelDelivery()` gives an Agent one tool, `send_message` by default. The tool sends a message through a [Channel](/docs/agents/channels) client to a recipient that the application selects. The model only writes the message.

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

## Agent-visible tool contract

The tool accepts one field, `message`, a non-empty string. On success, it returns `{ deliveryId, sent: true }`.
Without `description`, the tool description names the Channel and states how many times the Agent can call the tool.

## How Channel delivery works

- The tool trims the message. `validate` can throw to reject it. The model receives the error and can retry. A rejected message does not count as a call.
- `format` builds the Channel text from the message. It receives the Capability context, so it can read the Agent Invocation input context. A formatter failure, or formatted text that is empty, does not count as a send attempt.
- The tool calls `channel.send(text, options)`. A send error is thrown to the model.
- The tool counts each send attempt before it sends. After `maxCalls` attempts, the tool returns `CHANNEL_DELIVERY_LIMIT` before validation or formatting. A failed send also counts, because it can still reach the recipient.
- With `required: true`, the Agent Invocation fails with `CHANNEL_DELIVERY_REQUIRED` when the Agent finishes without a successful send. The requirement also applies when an input Capability handles the Agent Invocation before the Driver runs, regardless of Capability order. Streams and `Response` bodies are checked when they finish normally. When the Agent Invocation fails with another error or is cancelled, delivery is not required.
- Counters are per Agent Invocation. One definition can serve many Agent Invocations.
- The delivery tool name must be unique among Capability tools. A collision fails setup with `CHANNEL_DELIVERY_TOOL_CONFLICT` before the Driver runs.

## Requirements

- A Channel client with `send(text, options)` that returns `[error, null]` or `[null, { deliveryId }]`. `useChannel(name)` from `vite-hub/channels/server` returns one.
- `maxCalls` must be a positive integer.
- `channelDelivery()` throws a `TypeError` when the Agent Definition loads if `channel` has no `send()` function or `maxCalls` is invalid.

## Security and approval

- The model controls only `message`. The application fixes the Channel and the send `options`, such as the recipient. The model cannot change them.
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
2. Run `vitehub agent info --agent <name> --json`. Confirm that `tools` contains an entry with `name: "send_message"`, and that `capabilities` contains `{ id: "channel-delivery.send_message" }` with the expected `channel`, `maxCalls`, and `required` metadata.
3. Run the Agent with a test recipient. Confirm that the tool result contains a `deliveryId` and that the message arrives in the Channel.
4. With `required: true`, run the Agent with a prompt that does not ask for a send. Confirm that the Agent Invocation fails with `CHANNEL_DELIVERY_REQUIRED`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channel` | `{ name?: string, send(text, options) }` | required | The Channel client, for example `useChannel('teams')`. |
| `options` | send options | required | Options passed to `send()`, such as the recipient. The model cannot change them. |
| `name` | `string` | `"send_message"` | Tool name. The Capability ID is `channel-delivery.<name>`. |
| `description` | `string` | generated | Tool description for the model. |
| `required` | `boolean` | `false` | Fail the Agent Invocation without a successful send. |
| `maxCalls` | `number` | `1` | Maximum send attempts per Agent Invocation. |
| `format` | `(message, context) => string \| Promise<string>` | none | Build the Channel text from the message. |
| `validate` | `(message) => void \| Promise<void>` | none | Throw to reject a message. |

## Related pages

- [Channels](/docs/agents/channels)
- [Channels Server Primitive](/docs/server-primitives/channels)
- [Schedule Capability](/docs/capabilities/schedule)
- [Schedule primitive](/docs/server-primitives/schedule)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Official capabilities](/docs/capabilities/official-capabilities)
