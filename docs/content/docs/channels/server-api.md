---
title: Channels server API
description: Define a Channel, send messages through it from server code, and receive webhooks with signature checks, dedupe, and retry.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Define a Channel

A Channel is one connection to a platform, in `server/channels/<name>.ts`. The file name is the Channel name. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder, and its other files are helpers.

```ts [server/channels/alerts.ts]
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({
  adapter: {
    kind: 'telegram',
    async send(text: string, { chatId }: { chatId: string }) {
      const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (!response.ok) throw new Error(`Telegram answered ${response.status}`)
      const { result } = await response.json() as { result: { message_id: number } }
      return { id: String(result.message_id) }
    },
  },
})
```

| Option | Value |
| --- | --- |
| `adapter` | The connection. `stripe()` and `webhook()` from `vite-hub/channels` receive webhooks. `slack()`, `teams()`, `discord()`, `telegram()`, `github()`, and `gmail()` from `vite-hub/agent/channels` are chat, forge, and mail adapters. Your own adapter is an object with a `kind` and a `send(message, options)`. |
| `on` | Inbound targets by event name: a handler, or a trigger from `defineChannelTrigger()`. See [Receive webhooks](#receive-webhooks). |
| `instructions`, `capabilities`, `history` | Read by the Agent that lists the Channel in `defineAgent({ channels: ['name'] })`. |

## Send a message

`useChannel()` returns immediately. `send()` calls the adapter's `send` and returns a `Result` from `vite-hub/runtime`: `[undefined, receipt]` on success or `[error, undefined]` on failure. The message is non-empty text, or an object that the adapter's `send` accepts, such as a card. The options are the adapter's own send options. The receipt has the Channel name, a ViteHub delivery ID, and the optional provider message ID. Check the error before you use the receipt. See [Errors](#errors) for each code.

The optional provider `id` must be a string. Unreadable or non-string IDs are left out of the receipt and the delivery log.

Clients share one definition load per runtime registry. A failed load retries on the next send. A new registry clears the cache.

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', { chatId: '@build_room' })
  if (error) throw error
  return receipt
})
```

The handler returns a result like this:

```json
{
  "channel": "alerts",
  "deliveryId": "e4875238-2922-4787-9f7f-b13e2e7839be",
  "id": "1730000000000"
}
```

For each send, Channels tries to write `outbound.started` and either `outbound.completed` or `outbound.failed` JSON events under the `vitehub.channel.send` scope. Input checks and definition loading return before logging starts. Logging is best effort, and a logging failure does not change the result.

The events include `deliveryId`, the Channel, the adapter `kind`, and, when available, the provider message ID or the error message. ViteHub leaves out the message text and the options. Failed events include up to 2,000 characters of the thrown error message, so adapters must remove credentials and message content from provider errors before they throw.

Channels passes the original options object to the adapter. It keeps object identity, methods, and private state.

## Receive webhooks

A Channel with `webhook()` or `stripe()` receives webhooks at `/api/_vitehub/channels/<name>`, and at `path` when you set it. ViteHub checks the signature, stores the delivery, drops a delivery whose ID it already has, and runs the target of the event. Inbound Channels run on the Agent webhook route, so set `agent: true` next to `channels: true` in `vitehub()`.

```ts [server/queues/fulfil.ts]
import type { StripeEvent } from 'vite-hub/channels'
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<StripeEvent>(async ({ payload }) => {
  console.log('fulfil', payload.data.object.id)
})
```

```ts [server/channels/stripe.ts] fragment
import { defineChannel, stripe } from 'vite-hub/channels'
import { sendQueue } from 'vite-hub/queue'

export default defineChannel({
  adapter: stripe(),
  on: {
    'checkout.session.completed': event => sendQueue('fulfil', event.data),
  },
})
```

A handler gets the event, `{ name, id, data }`, where `data` is the parsed body, and `{ channel }`. With a queue-capable Agent State, such as the default SQLite State on Node, the webhook answers when the delivery is stored, and the handler runs from the webhook queue. A handler that throws or returns a failed `Result` runs again, also after a restart. Deliveries of one event run one at a time. Without a queue-capable State, the handler runs before the webhook answers, and a failure answers 500 so that the provider retries.

An event without a target answers 200 with `{ accepted: false, reason }`, so the provider does not retry it.

| `webhook()` option | Value |
| --- | --- |
| `signature` | `'bearer'`, `'token'`, `'github-sha256'`, `'stripe-sha256'`, `{ preset: 'hmac-sha256', prefix, encoding, secretEncoding }`, or `{ verify }`. Required with `secret`. |
| `secret` | A string, a sealed Server Env secret, or a function that returns one. Required with `signature`. `secret: false` without `signature` accepts requests that anyone can send. |
| `header` | The header with the signature. `bearer` reads `authorization`, `github-sha256` reads `x-hub-signature-256`, and `stripe-sha256` reads `stripe-signature`. `token` has no default, so set it. |
| `event` | `(payload, request) => name`. The name selects the `on` target. Defaults to `'webhook'`. |
| `id` | `(payload, request) => id`. The delivery ID that drops repeats. Defaults to the SHA-256 of the body. |
| `path`, `aliases` | More routes. String literals, because ViteHub reads them without running the module. |
| `kind` | The provider name in logs and the Console. Defaults to `'webhook'`. |
| `stateScope`, `durableState`, `ackTimeoutMs` | Delivery State options. See [Triggers](/docs/agents/triggers). |

`stripe({ secret, path, toleranceSeconds })` is `webhook()` with the `stripe-sha256` signature, the event type as the event name, and the event ID as the delivery ID. `secret` defaults to `STRIPE_WEBHOOK_SECRET`.

### Choose the delivery rules with a trigger

A trigger that selects no task runs the Agent that lists the Channel. Use `defineChannelTrigger()` from `vite-hub/agent/channels` when you choose the delivery ID, `serialize`, `debounce`, a task, or an Agent for each delivery, or when you read a provider's change log with `context.pull()` and keep state with `channelState.transaction()`. See [Triggers](/docs/agents/triggers).

```ts [server/channels/prefect.ts]
import { defineChannelTrigger } from 'vite-hub/agent/channels'
import { defineChannel, webhook } from 'vite-hub/channels'

export default defineChannel({
  adapter: webhook({ kind: 'prefect', signature: 'bearer', secret: () => process.env.PREFECT_WEBHOOK_SECRET }),
  on: {
    webhook: defineChannelTrigger({
      tasks: {
        triage: {
          // The task runs from the stored input, so `invoke` stays fast.
          // A task can also set `agent` to start an Agent instead.
          run: (_context, { input }) => console.log('triage', input.data),
        },
      },
      invoke: (_context, input: { payload: { flow_run_id: string } }) => ({
        task: 'triage',
        // One delivery per flow run, one triage at a time.
        webhook: { deliveryId: `prefect:${input.payload.flow_run_id}`, serialize: 'prefect' },
        input: { data: input.payload },
      }),
    }),
  },
})
```

Next to `on` handlers, a trigger must set `webhooks: []`, because the handlers receive the webhook. It then runs through `context.dispatch()` and `context.pull()`.

## Start a trigger from code

`sendChannelTrigger(channel, trigger, input)` starts a trigger or an `on` handler of a Channel from server code, such as a Schedule that reconciles a webhook that a provider lost. The trigger's `invoke` gets `input` as it gets a verified webhook body, and ViteHub admits the result to the webhook queue with the same delivery ID, `serialize`, `debounce`, and Channel State rules. A delivery ID that the queue already has is a duplicate, so the reconcile and the real webhook run the work once.

```ts [server/schedules/payments-reconcile.ts]
import { sendChannelTrigger } from 'vite-hub/channels'
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({
  cron: '0 * * * *',
  async handler() {
    const event = { id: 'evt_missed', object: 'event', type: 'checkout.session.completed', created: 0, livemode: false, pending_webhooks: 0, data: { object: { id: 'cs_missed' } } }
    const [error, receipt] = await sendChannelTrigger('stripe', 'checkout.session.completed', event)
    if (error) throw error
    console.log(receipt.queued ? 'queued' : 'already queued', receipt.deliveryId)
  },
})
```

`sendChannelTrigger()` returns `[undefined, { deliveryId, queued }]` or `[error, undefined]` with `CHANNEL_TRIGGER_FAILED`. `queued` is `false` when the queue already had the delivery or the trigger answered without one, such as `ignored()`. The trigger's `context.dispatch()`, `context.pull()`, and `channelState.transaction()` work as on the webhook route. It needs the persistent server that hosts the Channel, with SQLite or libSQL Agent State, like `enqueueChannelTask()`.

## Send through a chat adapter

The chat adapters in `vite-hub/agent/channels` also send: `teams()`, `slack()`, `discord()`, and `telegram()`. Each one sends through one Chat SDK adapter, which it builds on the first send. Text is Markdown. An object goes to the Chat SDK adapter as is, so a card from `Card()` in `chat` shows as an Adaptive Card in Teams and as Block Kit in Slack. Use `{ raw }` for text without Markdown conversion. Enable KV when you use `thread`, `idempotencyKey`, or `replace`.

```ts [server/channels/teams.ts]
import { teams } from 'vite-hub/agent/channels'
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({ adapter: teams() })
```

| Adapter | Chat SDK adapter for sends | `thread` | `replace` |
| --- | --- | --- | --- |
| `teams()` | Built from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, and `TEAMS_API_URL`. Install `@chat-adapter/teams`. | Yes | Yes |
| `slack({ adapter })` | Required. Pass your adapter, such as `createSlackAdapter()` from `@chat-adapter/slack`. | Yes | Yes |
| `discord()` | Built from `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_PUBLIC_KEY`. Install `@chat-adapter/discord`. | No | Yes |
| `telegram()` | Built from `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API_BASE_URL`, or the `botToken` and `apiBaseUrl` options. | No | Yes |

Each adapter also accepts `{ adapter }` with your own Chat SDK adapter or a function that returns it. An adapter without `thread` support throws a `TypeError` for a send with `thread`, and `send()` returns it as `CHANNEL_SEND_FAILED`.

```ts fragment
const [error] = await useChannel('teams').send('**Build failed**', {
  recipient: teamsChannelThreadId,
  thread: { key: `build:${buildId}`, root: `Build ${buildId}` },
  idempotencyKey: `build:${buildId}:failed`,
})
if (error) throw error
```

| Option | Value |
| --- | --- |
| `recipient` | A Chat SDK thread ID where the bot got a message, or `user:<id>` for a direct message. |
| `thread` | Optional. Sends with the same `key` reply under one root. ViteHub posts the root once, from `root` or the first message, and stores it in KV. The recipient must be a channel without a message ID. |
| `idempotencyKey` | Optional. A repeated key for the same recipient returns the stored receipt and posts nothing. |
| `update` | Optional. With `idempotencyKey`, a repeated key edits the stored message and returns the same receipt. Without a stored receipt, it posts as usual. |
| `replace` | Optional. Needs `idempotencyKey`. Set it to the `idempotencyKey` of an earlier send to the same `recipient` and `thread`, not this send's key. After this send posts or edits, ViteHub deletes that message and its receipt. Without a stored receipt, it deletes nothing. |

Send a card with `fallbackText` for notifications and clients that cannot show it. The `ChatMessage` type from `vite-hub/agent/channels` lists every form.

```ts fragment
import { Card, CardText } from 'chat'

const card = Card({ title: `Build ${buildId}`, children: [CardText(`Failed on ${branch}.`)] })
const [error] = await useChannel('teams').send({ card, fallbackText: `Build ${buildId} failed` }, { recipient: teamsChannelThreadId })
if (error) throw error
```

Use `update` to keep one message current, such as a status card:

```ts fragment
const [error] = await useChannel('teams').send(`Build ${buildId}: ${status}`, {
  recipient: teamsChannelThreadId,
  idempotencyKey: `build:${buildId}:status`,
  update: true,
})
if (error) throw error
```

Teams and Slack do not notify users of edits. To notify, post the result as new and use `replace` to delete the temporary message:

```ts fragment
const options = { recipient: teamsChannelThreadId, thread: { key: `ticket:${ticketId}`, root: `Ticket ${ticketId}` } }
const [draftingError] = await useChannel('teams').send('Drafting a suggested reply...', { ...options, idempotencyKey: `ticket:${ticketId}:drafting` })
if (draftingError) throw draftingError
const [error] = await useChannel('teams').send(suggestion, {
  ...options,
  idempotencyKey: `ticket:${ticketId}:suggestion`,
  replace: `ticket:${ticketId}:drafting`,
})
if (error) throw error
```

Set `thread.root` on the first send so the temporary message is a reply, not the root. Replacing the root throws a `TypeError` before any post or edit, so the thread and receipts stay.

ViteHub stores the new receipt, then deletes the old message. A failed delete returns the error, and a retry with the same options deletes again. A message the platform no longer has counts as deleted.

ViteHub stores roots and receipts in KV under the channel name, such as `teams:` or `slack:`, and keeps them until you remove them. Sends with the same key run one after another within one process. Two processes that send with the same new key at the same time can each post a root, so keep one sender per key or one replica.

## Errors

`send()` returns these errors. Each one has `code`, `why`, `fix`, and `docs`. `error.cause` keeps the lower-level error. `JSON.stringify(error)` does not include `cause`, so an adapter error that contains private data does not leave the server.

### CHANNEL_DEFINITION_FAILED

No Channel Definition has this name, or its file failed to load. Add `server/channels/<name>.ts` with a default export from `defineChannel()`, and read `error.cause` for the load error. A later `send()` loads the definition again.

### CHANNEL_INVALID_SEND

The text is empty, the options are not an object, or the adapter has no `send`, such as `stripe()`. `error.why` names the problem. Pass non-empty text and an options object, and send through a Channel whose adapter sends.

### CHANNEL_TRIGGER_FAILED

`sendChannelTrigger()` could not start the trigger. The Channel has no trigger or `on` handler with that name, no Agent webhook queue runs in this process, the State cannot queue, or the trigger threw. `error.cause` keeps the reason.

### CHANNEL_SEND_FAILED

The adapter threw, or it returned a value that is not an object. `error.cause` keeps the adapter error. The message can still have reached the recipient, so check before you send it again.
