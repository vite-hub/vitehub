---
title: Channel delivery
description: Let an Agent send its result through a Channel to a recipient that the application selects.
navigation.title: Channel delivery
navigation.order: 97
navigation.group: Runtime primitives
icon: i-lucide-send
---

`channelDelivery()` gives an Agent one tool, `send_message` by default. The tool sends a message through a Channel to a recipient that the application selects. The model only writes the message.

Use it when an Invocation must deliver its result somewhere other than the Channel that started it. Examples are a Schedule that sends a report to a Teams user, or a webhook Agent that sends a draft to a reviewer.

## Send from a Schedule

Pass the Channel client from `useChannel()` and the send options. Set `required` when the Invocation must fail without a successful send:

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

## Behavior

- The tool trims the message. `validate` can throw to reject it. The model receives the error and can retry. A rejected message does not count as a call.
- `format` builds the Channel text from the message. It receives the Capability context, so it can read the Invocation input context. A formatter failure does not count as a send attempt.
- The tool counts each send attempt before it sends. After `maxCalls` attempts, the tool returns `CHANNEL_DELIVERY_LIMIT` before validation or formatting. A failed send also counts, because it can still reach the recipient.
- With `required: true`, the Invocation fails with `CHANNEL_DELIVERY_REQUIRED` when the Agent finishes without a successful send. The requirement also applies when an input Capability handles the Invocation before the Driver runs, regardless of Capability order. Streams and `Response` bodies are checked when they finish normally. Cancelling output does not require delivery.
- Counters are per Invocation. One definition can serve many Invocations.
- The delivery tool name must be unique among Capability tools. A collision fails setup with `CHANNEL_DELIVERY_TOOL_CONFLICT` before the Driver runs.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channel` | `{ send(text, options) }` | required | The Channel client, for example `useChannel('teams')`. |
| `options` | send options | required | Options passed to `send()`, such as the recipient. The model cannot change them. |
| `name` | `string` | `"send_message"` | Tool name. The Capability ID is `channel-delivery.<name>`. |
| `description` | `string` | generated | Tool description for the model. |
| `required` | `boolean` | `false` | Fail the Invocation without a successful send. |
| `maxCalls` | `number` | `1` | Maximum send attempts per Invocation. |
| `format` | `(message, context) => string` | none | Build the Channel text from the message. |
| `validate` | `(message) => void` | none | Throw to reject a message. |

## Related pages

- [Channels](/docs/reference/channels)
- [Schedule](/docs/capabilities/schedule)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
