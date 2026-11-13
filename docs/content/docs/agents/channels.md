---
title: Agent Channels
navigation.title: Channels
description: Connect an Agent to web chat and messaging platforms without mixing transport with identity.
navigation.order: 40
navigation.group: Channels
icon: i-lucide-radio
navigation.kind: Guides
---

A Channel connects your Agent to a place where people send messages, such as a web chat, Slack, or GitHub. When a message arrives, the Channel starts an Invocation (one run of the Agent) and sends the reply back to the same place.

Use [Trusted Invokers](/docs/agents/trusted-invokers) for trusted identity and [Input Commands](/docs/agents/capabilities/input-commands) for explicit command handling.

## Supported channels

Each helper connects incoming messages or events to an Invocation. Set up the provider credentials and permissions first.

::supported-channels
::

A Channel is one connection in `server/channels/<name>.ts`, defined with `defineChannel()` from `vite-hub/channels`. The same Channel also sends from server code with `useChannel(name).send()`. See [Channels](/docs/channels) for webhooks from HTTP senders, such as Stripe, that go to a handler, a Queue, or a Workflow.

## Add a Channel

Define the Channel in `server/channels`, with an adapter from `vite-hub/agent/channels`. Then list its name in the Agent.

```ts [server/channels/portal.ts]
import { webChat } from 'vite-hub/agent/channels'
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({ adapter: webChat() })
```

```ts [server/channels/github.ts]
import { github } from 'vite-hub/agent/channels'
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({ adapter: github() })
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  channels: ['portal', 'github'],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The Agent answers the messages of each Channel that it lists. A Channel sends its messages to one Agent, so two Agents cannot list the same name. ViteHub reads the names from the Agent file, so write them as string literals. A Channel that adds an Agent Workspace, such as `github({ pullRequest: { workspace: true } })`, goes inline instead: `channels: { github: github({ pullRequest: { workspace: true } }) }`. Code that builds an Agent outside `server/agents`, such as a test, also passes its Channels inline, by name.

The server bundle contains only the adapters that you import, so an Agent with only `webChat()` does not ship the Discord or Teams adapters. Every Channel also answers webhooks at `/api/_vitehub/channels/<name>`.

Built-in adapters include `discord()`, `github()`, [`gitlab()` and `forgejo()`](/docs/agents/forge-channels), [`gmail()`](/docs/agents/gmail), `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()`. Use `channelAdapter(kind, options)` for a platform without a built-in adapter, such as your own Chat SDK adapter.

- `webChat()` adds a generated AI SDK chat route by default.
- `http()` is a generic HTTP Channel. Its route stays off until `http({ route: true })`.
- `teams()` tells the Agent to cite sources as descriptive Markdown links to verified URLs. A native web citation that the Chat SDK cannot resolve shows `[source link unavailable]`, also while streaming. Codex app-server gives no citation-ID-to-URL map, so those links cannot be recovered. Ordinary links stay as they are.

## Try Channels without credentials

Set `agent.channels.simulate` to talk to the Agent through its Slack, Discord, Teams, and Telegram Channels in `vite dev` before you create any bot or token:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node', agent: { channels: { simulate: true } } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: { channels: { simulate: true } } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: { channels: { simulate: true } } })],
})
```
:::
::

Each simulated Channel replaces its provider with the Chat SDK [web adapter](https://chat-sdk.dev/adapters/official/web). Its webhook route accepts an AI SDK chat request and streams the reply as an AI SDK UI message stream:

```sh
curl -N http://localhost:3000/api/_vitehub/agents/support/webhooks/discord \
  -H 'content-type: application/json' \
  -d '{"id":"try-1","messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"Hello"}]}]}'
```

Open the Channel's webhook URL in a browser, such as `http://localhost:3000/api/_vitehub/agents/support/webhooks/discord`, to chat with the Agent in a page that looks like the platform. The page is an unofficial simulator. It sends each message to the same route and shows the reply as it streams. Its top bar links the chat pages of the Agent's other simulated Channels.

`pnpm vitehub channels list` marks each simulated Channel and prints the path of its chat page. The `channels.list` operation returns them as `simulated: true` and `simulator`. The Console Channels page marks them too, and shows the chat page of the selected one with an **Open chat** button.

Point an AI SDK `useChat` client at the same route to chat from a page. The Agent still runs as that Channel, with its instructions and message settings. Simulated delivery runs inline within the HTTP request, even with `messages.durable: true` or an active Workflow runtime. A simulated Channel is a direct message with one user: mentions, threads, cards, and buttons are not simulated. Webhook verification, Telegram polling, and the Discord Gateway are off.

The option sets the Server Env value `VITEHUB_CHANNELS=simulate` in `vite dev` only, and `vite dev` prints a line when it does. `VITEHUB_CHANNELS=simulate vite dev` works too. The runtime ignores the value when `NODE_ENV` is `production`.

Simulation applies to every app in the same Node.js process. To simulate only one app, start its dev server in a separate process.

## Answer replies in subscribed threads

Built-in chat Channels answer in a shared channel only when mentioned. To also answer human messages in threads the Agent follows (subscribed threads), set `messages.replyToSubscribedThreads: true` on the Agent or one Channel:

```ts
import { teams } from 'vite-hub/agent/channels'

teams({
  messages: {
    replyToSubscribedThreads: true,
  },
})
```

- A mention subscribes the conversation through the Agent's chat state. A host that creates bot threads must subscribe them through the same store.
- Unmentioned messages in other threads, and from other bots, stay ignored. Direct messages and mentions work as before.
- Message filters get `deliveryKind: 'subscribed'`. All concurrency modes use the same admission rules.
- The provider must deliver the messages. A Teams app installation needs permission and consent to read channel messages.

## Ignore other bots

Built-in chat Channels ignore bot messages, also mentions and direct messages, so two bots cannot answer each other forever. The Chat SDK already skips the Agent's own messages. To accept other bots, set `messages.allowBots: true` on the Agent or one Channel:

```ts
import { teams } from 'vite-hub/agent/channels'

teams({
  messages: {
    allowBots: true,
  },
})
```

An ignored bot message is recorded as a `rejected` delivery and never reaches `messages.filter`.

## Steer with other participants

With `messages.concurrency: 'steer'`, a new message can redirect (steer) the active Invocation. Only the invoker (who started it) can steer by default. Others wait and start their own Invocation. To let others in the thread steer, set `messages.steerFromParticipants: true`:

```ts
import { teams } from 'vite-hub/agent/channels'

teams({
  messages: {
    concurrency: 'steer',
    durable: false,
    steerFromParticipants: true,
  },
})
```

- The message must pass admission: groups still need a mention, and `messages.filter` and `access()` apply.
- Only human authors in the same thread can steer, even when `lockScope` covers several threads.
- The Invocation keeps the first invoker's identity and authority. The steering message is input only, and its header names its author.
- If the Driver (the part that runs the Agent) cannot steer live, the message runs as its own Invocation afterwards, as for one invoker.
- This applies to inline steering. With durable Workflow delivery, another invoker's message still queues separately.

## Act on the Channel message in hooks

Hooks let the Agent act on the message that started it, for example to label an email. The `agent:finish` and `agent:error` hooks get `event.message`, a handle for that message.

1. Declare the handle's methods with `channelAdapter(kind, { message })`.
2. In the Trigger (the function that turns a provider event into an Invocation), return JSON `message` data that identifies the provider message.
3. Each method gets the Channel context first, with the Trigger's data in `context.message`. A `message.data` Standard Schema validates it when you set one.

```ts [server/agents/labeller.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { channelAdapter, defineChannelTrigger } from 'vite-hub/agent/channels'
import * as v from 'valibot'
import { applyLabels, readEmail } from '../lib/mailbox'

// Inline, so TypeScript types `event.message` from the methods.
const mailbox = channelAdapter('mailbox', {
  message: {
    data: v.object({ id: v.string() }),
    methods: {
      label: (context, labels: string[]) => applyLabels(context.message.id, labels),
      subject: {
        read: true,
        handler: async context => (await readEmail(context.message.id)).subject,
      },
    },
  },
  messages: false,
  triggers: {
    received: defineChannelTrigger({
      input: v.object({ id: v.string(), subject: v.string() }),
      invoke(context, email) {
        return {
          input: { prompt: `Choose one label for: ${email.subject}` },
          message: { id: email.id },
          run: { channelId: context.trigger.channelId, origin: 'mailbox', runId: `mailbox:${email.id}` },
        }
      },
    }),
  },
})

export default defineAgent({
  channels: { mailbox },
  driver: { model: 'openai/gpt-5.1-mini' },
  hooks: {
    async 'agent:finish'(event) {
      if (event.message?.channel !== 'mailbox' || !event.text) return
      await event.message.label([event.text.trim()])
    },
  },
})
```

`event.message` has:

| Property | Value |
| --- | --- |
| `channel` | The Channel name in the Agent's `channels` map. |
| `kind` | The Channel Kind, such as `'mailbox'` or `'telegram'`. |
| `data` | The Trigger's `message` data, typed by `message.data`. |
| Methods | One async function per method, without the context argument. |

TypeScript infers the handle from `channels`. With several Channels it is a union: check `event.message.channel` to narrow it. Without a Channel, it is `undefined`. `channel`, `data`, and `kind` are reserved names.

Built-in Channels add what their adapter supports. `discord()`, `slack()`, `teams()`, and `telegram()` give `reply()` when an adapter is configured and messages are on. `github()` gives `reply()`, `reaction()`, and `status()` with a GitHub App. `event.reply()` still returns a reply that ViteHub delivers after the hook, or that a custom Channel's `reply` method handles.

### Dry run

A dry run runs an Agent on real messages without changing them. Set `dryRun: true` in the Invocation input, from a Trigger's returned `input` or in `runAgent()`.

A method declared as a function is a write. A dry run skips writes and built-in delivery, including the automatic reply, records each call as a skipped delivery, and returns `undefined`. Methods declared as `{ read: true, handler }` still run.

The Console shows the call, such as `label(["Receipts"])`. This text is Invocation content, kept only with `content: 'content'` or when `metadataContent` lists `channel.effect.content`, as the Console store does.

## Webhook paths

Set `webhooks.path` to choose the webhook URL. On Nitro hosts, it is served next to `/api/_vitehub/agents/:agent/webhooks/:webhook` with the same handler, authentication, HEAD probe, and history export. Other routes keep their request body.

- When Agents share a path, each Agent's `publicUrl` host selects by request host.
- `agent.routes.aliases[path]` set to `{ agent, webhook }` picks the owner yourself.
- A path with no clear owner answers HTTP 409 instead of picking an Agent.
- `webhooks.aliases` adds paths, such as an old URL a provider still calls.

### Give a Channel its own route

A Channel with the `webhook()` or `stripe()` adapter from `vite-hub/channels` does not need an Agent. Put it in `server/channels/<name>.ts` and ViteHub serves `/api/_vitehub/channels/<name>`, plus the adapter's `path` and `aliases`. A trigger selects the Agent that runs with a [task](/docs/agents/triggers):

```ts [server/channels/tickets/index.ts] fragment
import { defineChannelTrigger } from 'vite-hub/agent/channels'
import { defineChannel, webhook } from 'vite-hub/channels'
import { ticketEvent } from './events'

export default defineChannel({
  adapter: webhook({ kind: 'tickets', path: '/api/tickets/webhook', aliases: ['/webhooks/tickets'] }),
  on: {
    webhook: defineChannelTrigger({
      input: ticketEvent,
      tasks: { triage: { agent: () => import('../../agents/triage') } },
      invoke: (context, event) => ({ task: 'triage', input: { prompt: `Triage ticket ${event.id}.` } }),
    }),
  },
})
```

- The Channel name comes from the file, or from the folder of an `index` module. In a folder with an `index` module, the other files, such as `events.ts`, are helpers.
- ViteHub reads `path` and `aliases` from the source without running the module. Use string literals, or `const` values in the same module that hold them. Any other value fails the build with `AGENT_B0024`.
- When an Agent lists the Channel, that Agent serves its routes. Otherwise the route also answers at `/api/_vitehub/agents/channel-<name>/webhooks/<name>`. `channel-<name>` is the host that owns the Channel's webhook State and queue. It is not an Agent Definition, so it cannot have the name of one.
- Channels that receive webhooks without an Agent need a Nitro host. Restart the development server after you add or remove one.

A task's `agent` can be a definition or a resolver that returns a definition or its default-export module. Use a lazy import as above when the target Agent lists this Channel. ViteHub resolves it before binding the task callbacks and stores the resolved Agent name with queued deliveries. Keep static imports of the owning Agent out of the Channel and its helpers. ViteHub reports cycles through local imports at build time.

### Keep webhook State when a Channel moves

ViteHub keeps a webhook's State and queue under `webhook:<agent>:<origin>:<registration>:`. Accepted queued deliveries, provider cursors, and Channel State all use this scope. When you move a Channel to another owner, for example from an Agent to `server/channels/<name>.ts`, the scope changes, and the new owner does not see the old data.

Set `stateScope` on the adapter to the old scope to keep it:

```ts [server/channels/airtable/index.ts]
import { defineChannel, webhook } from 'vite-hub/channels'

export default defineChannel({
  adapter: webhook({
    kind: 'airtable',
    path: '/api/airtable/webhook',
    durableState: true,
    stateScope: 'webhook:support:airtable:airtable:',
  }),
  on: { /* ... */ },
})
```

- ViteHub uses the value as the scope, with one trailing colon. A value that is not a string, or that is empty, makes the route throw a `TypeError`.
- Give each Channel its own `stateScope`, and remove the Channel from the old owner. ViteHub does not check that a scope is unique. Channels with the same scope share one queue and one Channel State.

### Verify a webhook signature

Set `signature`, `secret`, and `header` on the `webhook()` adapter, or `secretHeader`, `secretToken`, and `signature` on a webhook registration of `channelAdapter()`. ViteHub verifies the raw request body before it runs the trigger and answers `401` when the check fails.

| `signature` | The header carries |
| --- | --- |
| Not set | The `secretToken` value itself. |
| `'bearer'` | `Bearer <secretToken>`. `secretHeader` defaults to `'authorization'`. |
| `'github-sha256'` | `sha256=` and the hex HMAC-SHA256 of the body. |
| `'stripe-sha256'` | `t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. |
| `{ preset: 'hmac-sha256', prefix?, encoding?, secretEncoding? }` | `prefix` and the HMAC-SHA256 of the body, in `'hex'` (default) or `'base64'`. |
| `{ verify }` | Anything. Your callback receives `{ header, rawBody, request, secret }` and returns `true` to accept. |

`github-sha256` is the HMAC preset with `prefix: 'sha256='`. Set `secretEncoding: 'base64'` for a base64 key. An invalid base64 key fails verification.

`bearer` compares the token in constant time, with a case-insensitive scheme. A missing header or wrong token answers `401`. When `secretToken` gives no secret, the webhook answers `500` naming the Channel, so a missing secret never leaves the route open. Return `false` from `secretToken` to turn verification off.

`secret` also accepts a Server Env secret (read from the server environment). ViteHub calls `unseal()` when it verifies the request:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    env: {
      server: {
        prefect: { webhookSecret: env({ secret: true, source: env.source('PREFECT_WEBHOOK_SECRET') }) },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    env: {
      server: {
        prefect: { webhookSecret: env({ secret: true, source: env.source('PREFECT_WEBHOOK_SECRET') }) },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    env: {
      server: {
        prefect: { webhookSecret: env({ secret: true, source: env.source('PREFECT_WEBHOOK_SECRET') }) },
      },
    },
  })],
})
```
:::
::

```ts [server/channels/prefect.ts]
import { defineChannel, webhook } from 'vite-hub/channels'
import { useServerEnv } from '#vitehub/env/server'

export default defineChannel({
  adapter: webhook({
    kind: 'prefect',
    path: '/api/prefect/webhook',
    secret: () => useServerEnv().prefect.webhookSecret,
    signature: 'bearer',
  }),
  on: { /* ... */ },
})
```

```ts [server/channels/airtable.ts]
import { defineChannel, webhook } from 'vite-hub/channels'

export default defineChannel({
  adapter: webhook({
    kind: 'airtable',
    path: '/api/airtable/webhook',
    header: 'x-airtable-content-mac',
    secret: () => process.env.AIRTABLE_MAC_SECRET,
    signature: { preset: 'hmac-sha256', prefix: 'hmac-sha256=', secretEncoding: 'base64' },
  }),
  on: { /* ... */ },
})
```

### Answer slow webhooks early

Some providers wait only briefly. GitHub closes the connection after 10 seconds and never resends. A trigger that reads the provider API before queueing, or a starting process, can take longer.

With durable webhook State (State that survives restarts, such as SQLite, libSQL, or Cloudflare Durable Objects), ViteHub stores the verified request before the trigger runs and answers within `ackTimeoutMs` of arrival (default 5000 ms).

- If admission finishes in time, the provider gets the trigger's answer.
- Otherwise it gets `202 { accepted: true, deferred: true, ok: true }` and admission continues in the background. The provider never sees the trigger's own answer, such as `ignored()` or a returned `Response`.
- The stored request is removed when admission ends. If the process stops first, or admission ends in a 5xx, the next process replays it through the route at startup.
- Replays check the signature again. A timestamped signature such as `stripe-sha256` is checked against the first arrival, so late replays still pass.
- A request gets at most 3 admissions.

The request is stored at `<scope>inbox:<id>`, where the ID is the delivery header, such as `x-github-delivery`, or the SHA-256 of the body. On shutdown, the queue waits up to `VITEHUB_SHUTDOWN_DRAIN_MS` for deferred admissions.

```ts [server/agents/support.ts] fragment
webhooks: {
  path: '/api/github/webhook',
  ackTimeoutMs: 8_000, // `false` waits for admission
}
```

An invalid trigger result, such as queued input that is not JSON-serializable while the trigger uses `prepare`, answers 5xx and records a `failed` delivery with the reason in `error`.

Chat message webhooks always wait for admission. Logs use `scope: "vitehub.channel.delivery"` with `admission.deferred`, `admission.completed`, `admission.failed`, `inbox.replaying`, `inbox.replayed`, and `inbox.dropped`.

## See and export a conversation

A chat Channel keeps one conversation per provider thread, such as one Telegram chat. The Console **Channels** section, the `channels.*` operations, and the CLI show every message in order, its author, its attachments, and the Invocation that answered. Download it as Markdown or as the `channels history` archive.

The conversation merges three sources, and no message appears twice:

| Source | What it holds | Limit |
| --- | --- | --- |
| Provider history and thread cache | Messages and attachments. Telegram has no history API, so the adapter's thread cache is read. | The `threadHistory` window: 100 messages for seven days. |
| Transcripts | Every inbound and outbound message, in Chat SDK's transcript store. See [Keep transcripts](#keep-transcripts). | `transcripts.maxPerUser` and `retention`. At most 500 entries per person, then the result is marked `truncated`. |
| Invocations | The starting message and later replies carry its `invocationId`. With `invocations: { content: 'content' }`, it also adds a prompt or reply that no other source still has. | The journal's retention. |

- Entries with the same platform message id are one message.
- An entry without an id matches a message with the same role and text within one minute, at most once per message.
- An edit repeats the id, and the last entry wins.
- A message the provider reports as deleted is dropped with its transcript copies.
- At equal times, the person sorts before the Agent, and a reply never sorts before its starting message.
- Overlapping Invocations can record identical replies. Each delivered message is kept, with `invocationId` unset when the records cannot tell the sender, and no extra copy is made from them, even when fewer deliveries remain than recorded replies.

### Keep transcripts

A transcript keeps messages after the provider forgets them. With durable Agent State (libSQL or a Cloudflare Durable Object), every chat message in and out goes to the transcript store, so your State holds conversation text for each author. Set `transcripts: false` on a Channel, or `messages: { transcripts: false }` for all, to keep none. Pass a config to set limits:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { telegram } from 'vite-hub/agent/channels'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  channels: {
    support: telegram({ messages: { transcripts: { maxPerUser: 500, retention: '90d' } } }),
    private: telegram({ messages: { transcripts: false } }),
  },
})
```

`channels.list` reports `durable-transcripts` for Channels with transcripts in durable State, else `provider-window`, and then the Console and Markdown export warn that older messages can be missing, because Telegram keeps only 100 messages for seven days. Delete a person's transcripts with Chat SDK's `history.user.delete()`.

### Who can read a conversation

Conversations are private. Every surface answers `CHANNELS_THREAD_UNKNOWN` (404) for a thread with no Invocation of this Channel and no transcript. The check runs before the provider is asked, so nobody can use the bot token to read another chat. A group thread with a transcript but no Invocation is not found. Admitted-Invocation evidence is kept in State, so group transcripts stay readable without the journal. Rejected messages do not make a group known.

On the Console, the CLI, and the [ViteHub MCP](/docs/development/mcp), anyone allowed into the `channels` section reads every thread. `console.authorize` decides who. An Agent using `operations()` reads nothing until the Capability (a feature you give the Agent) sets `conversations`:

```ts [server/agents/support.ts] fragment
operations({ include: ['channels.*', 'conversations.export'], conversations: 'participant' })
```

`channels.*` does not match `conversations.export`, so list it as well. `participant` lets the Agent read the threads where its Invoker takes part. That means the Invoker id, its Auth user id (`invoker.meta.authUserId`), or the user id of the call equals the id of a person in the thread: an author, the user key of a transcript, or the person who started an Invocation. An Invoker without an identity that matches is refused with `CHANNELS_FORBIDDEN`. `all` lets it read every thread that the Channel knows. An Agent's `conversations.export` always waits for approval, unless `approve` is `'never'`, and never includes media.

### Operations and commands

| Operation | Input | Answer |
| --- | --- | --- |
| `channels.list` | none | Each Agent and Channel with its provider, retention, and `simulated`. A simulated Channel has its chat page path in `simulator`. |
| `channels.threads` | `agent`, `channel`, `cursor?`, `limit?` | Journal threads, newest first, with title, people, last activity, and run count, but no message count. |
| `channels.conversation` | `agent`, `channel`, `thread`, `cursor?`, `limit?` | The messages in order, each with `role`, `author`, `text`, `attachments`, `at`, and `invocationId`, and the `messageCount`. |
| `conversations.export` | `agent`, `channel`, `thread`, `format`, `media?` | `text` in `markdown` or `json`, and the attachment files when `media` is on. |
| `channels.status` | `agent`, `channel` | Sync health of a cursor-reading Channel such as [Gmail](/docs/agents/gmail#failed-messages): `status`, `failures`, `error`, `syncedAt`, and `retrying` and `skipped` messages. Others answer `CHANNELS_NO_STATUS`. An Agent needs `conversations: 'all'`. |

A `cursor` names the previous page's last item by id and time, so pages stay stable when messages arrive or the window moves.

```bash [Terminal]
pnpm vitehub channels list
pnpm vitehub channels threads support telegram
pnpm vitehub channels conversation support telegram telegram:456
pnpm vitehub channels status labeller gmail
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat
```

Without `--output`, the export goes to stdout without attachments. `--output <directory>` writes the file and a `media/` directory in the `channels history` layout, refusing server file names or paths that leave the directory. Add `--url <origin>` for a deployed app. See the [CLI](/docs/development/cli#export-a-channel-conversation).

The Markdown export is safe to open: each message sits in a fence longer than any backtick run in it, names in headings and links are escaped, and only `http(s)` URLs and export files become links.

The JSON export is the `channels history` archive with `schemaVersion: 1`. Messages keep every provider field, plus `role`, `source` (`provider`, `transcript`, or `invocation`), and `invocationId`. Quoted messages (`replyTo`) are searched for attachments at any depth. `retention` adds `durable`, and `truncated: true` marks oldest messages cut by the transcript limit. `vitehub channels history` writes the same messages from a signed request to the deployed webhook route, needs no known thread, and never breaks on a failing journal.

Errors: `CHANNELS_EXPORT_TOO_LARGE` (413) over 35 MiB, `CHANNELS_ADAPTER_MISSING` (500) without a Chat adapter, and `CHANNELS_HOST_UNAVAILABLE` (503) when the Agent State cannot read lists.

### State

The Console reads conversations with the State and the adapters that the webhook routes use. The generated webhook route module installs the reader when the server starts, for a libSQL State (the default in `vite dev`, or `VITEHUB_AGENT_STATE_URL` and `agent.providers.state`) and for a Cloudflare Durable Object State (`agent.providers.state.driver: 'cloudflare'`). On Cloudflare, the reader runs in a Worker that starts the webhook route module. A custom State that the generated code does not install makes the operations answer `CHANNELS_HOST_UNAVAILABLE` with the State options to use. A Channel with its own `history` collection has no per-thread conversation; use `channels history` and `channels replay` for it.

## Replay Channel history

Replay runs an Agent on messages from before it existed, or again after a change. Add `history` to the Channel:

- `history.collection` is a [Collection](/docs/source/server-api#expose-a-typed-collection), a typed list read page by page. Items have the trigger input shape, so replays take the live trigger path.
- `history.key` returns a stable item key, such as the provider message ID.
- `history.thread` optionally returns the item's conversation ID.

`vitehub channels history` uses this Collection for custom Channels, with `--thread`, repeatable `--query key=value`, and `--invocations`.

To join older Invocations without `vitehub.channel.key`, add `history.invocationItem(invocation): TItem | undefined | Promise<TItem | undefined>`. This read-only hook gets the stored `AgentInvocationRecord` and rebuilds an item for `key()` and `thread()`. Existing key annotations win. The journal keeps no raw trigger input or `input.context`, so return `undefined` when observations and annotations cannot identify the item. A throwing hook also leaves the record unjoined.

The Channel reads and labels messages through two helpers of the app, here over a JSON mail API:

```ts [server/lib/mailbox.ts]
const api = 'https://mail.example.com/api'

export interface Email { id: string, subject: string }

export async function listEmails(query: { after?: string, folder: 'archive' | 'inbox', limit: number }): Promise<Email[]> {
  const url = new URL(`${api}/messages`)
  url.searchParams.set('folder', query.folder)
  url.searchParams.set('limit', String(query.limit))
  if (query.after) url.searchParams.set('after', query.after)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The mail API answered ${response.status}`)
  return await response.json() as Email[]
}

export async function applyLabels(id: string, labels: string[]) {
  const response = await fetch(`${api}/messages/${id}/labels`, { method: 'POST', body: JSON.stringify(labels) })
  if (!response.ok) throw new Error(`The mail API answered ${response.status}`)
}
```

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { channelAdapter, defineChannelTrigger } from 'vite-hub/agent/channels'
import { defineCollection } from 'vite-hub/source'
import * as v from 'valibot'
import { applyLabels, listEmails } from '../lib/mailbox'

const email = v.object({ id: v.string(), subject: v.string() })

// Keep history Collections out of server/collections. That directory is a public read model.
const inbox = defineCollection(async ({ cursor, limit, query }) => {
  return await listEmails({ after: cursor, folder: query.folder, limit })
}, {
  cursor: message => message.id,
  cursorSchema: v.string(),
  querySchema: v.object({ folder: v.optional(v.picklist(['archive', 'inbox']), 'inbox') }),
})

const mailbox = channelAdapter('mailbox', {
  history: { collection: inbox, key: message => message.id },
  message: {
    data: v.object({ id: v.string() }),
    methods: {
      label: (context, labels: string[]) => applyLabels(context.message.id, labels),
    },
  },
  messages: false,
  triggers: {
    received: defineChannelTrigger({
      input: email,
      invoke: (context, message) => ({
        input: { prompt: `Choose one label for: ${message.subject}` },
        message: { id: message.id },
      }),
    }),
  },
})

export default defineAgent({
  channels: { mailbox },
  driver: { model: 'openai/gpt-5.1-mini' },
  hooks: {
    async 'agent:finish'(event) {
      if (event.message?.channel === 'mailbox' && event.text) await event.message.label([event.text.trim()])
    },
  },
})
```

Set `history.trigger` when the Channel has several triggers. Replay from the terminal with [`vitehub channels replay`](/docs/development/cli#download-channel-history):

```sh
pnpm vitehub channels replay --agent labeller --channel mailbox --folder archive --dry-run
```

Or call `replayChannel()` from trusted server code:

```ts [server/api/backfill.post.ts] fragment
import { replayChannel } from 'vite-hub/agent/server'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import labeller from '../agents/labeller'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { cursor } = await readBody<{ cursor?: string }>(event)
  return await replayChannel(labeller, 'mailbox', {
    cursor,
    limit: 50,
    query: { folder: 'inbox' },
    runtime: getRuntimeContext(event),
  })
})
```

- `--label <label>` (non-empty, at most 512 characters) groups replayed Invocations by the `triggeredBy` annotation. In code: `replayChannel(agent, channel, { label })`. It is not a query field: filter a `label` field with `--query label=value`.
- Repeatable `--query key=value` is an alias for `--filter key=value`.
- Forced rounds get separate Invocation IDs and labels. A replay without a label works as before.

With the Console on, the Vite dev loop uses the Console's Invocation journal (the stored Invocation records), also for `@vite-hub/agent` definitions. Local dry-run replays need no Invocation config.

An authenticated replay uses the saved item, so it needs no provider signature. Live webhooks still verify signatures, and replayed input still passes the trigger schema.

`replayChannel()` validates `query` with the Collection's schema and reads pages until `limit` or the end. It returns `processed`, `skipped`, and `failed` counts, one entry per item, and `nextCursor`, which you pass as `cursor` to continue, `null` at the end.

### How replay avoids duplicate runs

Each item gets the run ID `channel:<channel>:<key>`, with percent signs and colons escaped. A live message [dispatched](#start-several-invocations-from-one-webhook) with the same key gets the same ID. This needs an Invocation journal: configure `invocations` or turn on the [Console](/docs/development/console).

- Replay skips terminal and running Invocations and confirmed Workflow dispatches.
- An active claim stops one item from running twice at once.
- An inline run stays recoverable until its terminal status is stored. If the process is lost, a retry can claim it after the lease expires.
- An unconfirmed pending Invocation held by another claim reports a retryable failure.
- Workflow dispatch records its attempt before calling the provider. If recovery cannot see the run, it stays pending with a retryable failure, and a later replay checks the provider again. An `unknown` provider status does not prove a rejection.
- A reservation without a recorded attempt is recoverable after its claim expires. Older journals without this marker stay pending while the status is unknown.
- Replay also checks older `channel-replay:<channel>:<key>` IDs.

`force: true` replays handled items under new IDs, as separate Invocations. `dryRun: true` [records Channel message writes](#dry-run) instead of sending them, with `channel-dry-run:` IDs that never block a later live replay.

An inline Agent runs each item before reading the next and reports `completed`. An Agent with a [Workflow runtime](/docs/agents/invocations) starts one durable run per item and reports `started`. A trigger error, such as invalid input, marks that item `failed`, and replay continues.

#### Which Channels have history

[`gmail()`](/docs/agents/gmail#replay-past-mail) gives `history` from a Gmail search. Others do not: the Telegram Bot API cannot read past messages, and Slack, Discord, Teams, and GitHub history are not built in. Define a custom Channel with a history Collection for them.

### Start several Invocations from one webhook

Some providers send one webhook for several messages. A trigger can answer it and call `context.dispatch(items, { trigger })` to start one Invocation per item through another trigger of the Channel. Each item has an `input` and a `key`, and gets the replay ID, so items that already ran are skipped.

On a webhook delivery, `context.channelState` is the Channel's State Adapter. Store provider cursors under `context.channelState.keyPrefix`. Replayed deliveries get the same State.

A trigger that always needs State declares `durableState: true`. Its `invoke` gets `context.channelState` typed as present, and an unbound State, for example outside the webhook route, throws `AGENT_R1005` before `invoke`. Pair it with the Channel's `webhooks.durableState`, so the route answers `503` when the State is not durable.

```ts fragment
triggers: {
  changed: defineChannelTrigger({
    durableState: true,
    async invoke(context, input: { cursor: string }) {
      await context.channelState.state.set(`${context.channelState.keyPrefix}cursor`, input.cursor)
      return new Response(null, { status: 204 })
    },
  }),
}
```

```ts fragment
triggers: {
  push: defineChannelTrigger({
    async invoke(context, input: { messageIds: string[] }) {
      const messages = await readMessages(input.messageIds)
      context.waitUntil(context.dispatch(messages.map(message => ({ input: message, key: message.id })), { trigger: 'received' }))
      return new Response(null, { status: 204 })
    },
  }),
  received: defineChannelTrigger({ input: email, invoke: (context, message) => ({ input: { prompt: message.subject }, message: { id: message.id } }), webhooks: [] }),
},
```

Set `webhooks: []` on a dispatch-only trigger so the webhook route skips it.

### Queue dispatched items

`context.dispatch(items, { trigger, queue: true })` queues each item as its own webhook delivery instead of running it now.

- The receiving trigger must answer with `webhook.deliveryId` and `webhook.serialize` or `webhook.concurrencyLimit`, so `debounce` and queue retries apply.
- Items are admitted in order. The first that cannot be admitted throws, and later ones are not admitted.
- An item answered below 400 without a delivery, such as `ignored()`, is skipped as `handled`. An already-queued delivery ID is skipped as `duplicate`.
- A queued item that fails its last attempt runs the receiving trigger's `failed` callback.

Queued dispatch needs the webhook route to run the calling trigger with a queue-capable State, such as SQLite or libSQL. `dryRun` and `queue` do not combine.

Providers can resend changes or send them out of order. Give an item `order: { key, version }`, and it is skipped as `stale` before the trigger runs unless `version` beats the last one admitted or answered for `key` through that trigger. The version commits with the admission. If the trigger throws or answers 400 or above, it stays unchanged, so a retry is admitted.

```ts fragment
await context.dispatch(changes.map(change => ({
  input: change,
  key: change.eventId,
  order: { key: change.recordId, version: change.sequence },
})), { queue: true, trigger: 'change' })
```

### Pull a provider's change log

Some providers send a short notification and keep changes in a cursor-read log. `context.pull({ key, initialCursor, fetch, trigger, signal? })` reads it from the saved cursor:

1. It reads the cursor saved at `channelState.keyPrefix + key`, or uses `initialCursor`.
2. It calls `fetch(cursor, signal)` for a page `{ items, next, more, first? }`.
3. It admits each item in order through `trigger`, with queued dispatch, so `order` applies.
4. It saves `next` only after every item of the page is admitted, then fetches again while `more` is `true`.

It throws and keeps the cursor when `first` is not the requested cursor (a gap, such as expired history), a number cursor moves back, or `more` is `true` with an unchanged cursor. It checks `signal` before each fetch, item, and save. A failure or abort keeps the cursor, so the next pull refetches the page and skips admitted items as `stale` or `duplicate`. A lock on the key allows one pull at a time. `items` can be an async iterable that loads each item just before admission. The cursor is a number or string, typed like `initialCursor`.

```ts fragment
webhook: defineChannelTrigger({
  async invoke(context, notification: { webhookId: string }) {
    await context.pull({
      key: `cursor:${notification.webhookId}`,
      initialCursor: 1,
      trigger: 'change',
      async fetch(cursor, signal) {
        const page = await provider.payloads(notification.webhookId, { cursor, signal })
        return {
          items: page.changes.map(change => ({ input: change, key: change.eventId, order: { key: change.recordId, version: page.cursor } })),
          next: page.nextCursor,
          more: page.hasMore,
        }
      },
    })
    return ignored('pulled')
  },
}),
```

### Decide and write Channel State in one step

A trigger often reads a value, decides, and writes a new one, such as a record's last version. A transaction stops two deliveries from doing this at once. `context.channelState.transaction(key, run, { ttlMs?, waitMs? })` locks the key while `run` reads `value` and stages `set()` or `delete()`. `key` is relative to `channelState.keyPrefix`, and the type argument types the value. A second delivery waits up to `waitMs` (default 10 seconds), then throws so it retries.

```ts fragment
durableState: true,
invoke: (context, change: { id: string, version: number, text: string }) =>
  context.channelState.transaction<{ version: number }>(`record:${change.id}`, (record) => {
    if (record.value && record.value.version >= change.version) return ignored('stale_update')
    record.set({ version: change.version })
    return { input: { prompt: change.text }, webhook: { deliveryId: `${change.id}:${change.version}`, serialize: change.id } }
  }),
```

The staged write commits:

- with the queue admission of the returned Invocation, inside `invoke` on the webhook route or in a queued dispatch item
- at once, when the trigger answers below 400 without a queued delivery, such as `ignored()`, or the delivery runs inline
- when `run` returns, anywhere else

A throw, a `Response` of 400 or above, or a failed admission writes nothing and releases the lock, so the retry decides again. An expired lease (`ttlMs`, default 60 seconds) fails the commit without writing. Run at most one transaction per key per trigger call.

| State | Commit |
| --- | --- |
| SQLite and libSQL | One transaction checks locks, queues, and writes. A crash before it keeps the old value and queues nothing. |
| A custom State with `commitWebhookState()` | Its own transaction, same contract. |
| Other States, such as Cloudflare Durable Objects | Locks are extended, the delivery queued, then values written. A crash in between keeps the delivery and loses the write, so the retry decides again and the delivery ID removes the duplicate. Without a webhook queue, only `ignored()` and inline deliveries commit. |

## Publish Agent activity without opening a chat

Turn on `activity` to show Invocation progress in a Channel, such as a status comment on a GitHub pull request. It shows progress only, not the conversation.

On GitHub, the Agent keeps one PR comment. With GitHub App webhooks for `pull_request` events sent to the Agent's generated endpoint, the app creates it on `pull_request.opened`, and later Invocations reuse it. If `pullRequest.reconcile.events` excludes `opened`, or the webhook is not delivered, the first later Invocation creates it.

The comment shows a "Starting" row that claims the work, a newest-first table of current and recent sessions with links, status, relative start times, and completed durations, then the harness's (the coding agent, such as Codex) normalized task checkboxes and the newest session's final answer. A collapsed section lists all session answers, newest first, each with a session link. The full transcript stays in the linked session, if configured.

Updates keep their order within one process. Across concurrent hosts, GitHub delivery is best effort: intermediate updates can merge, and duplicate comments or briefly older state can appear. A later update fixes owned duplicates and old state when it can. Within one process, older updates never replace the current or terminal run.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({
      activity: { publicUrl: 'https://agent.example.com' },
      app: true,
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Set `activity.publicUrl` to the Console's public origin, so runs from GitHub PR webhooks link to their Invocation from the start. Use `activity: true` when the app supplies links itself. When the app starts the Invocation, it selects the Channel, destination, and links, such as the session, memory, or another inspection page.

```ts fragment
import { runAgent } from 'vite-hub/agent'

const [error] = await runAgent(agent, { prompt: 'Converge this pull request.' }, {
  runtimeContext: {
    runtime: 'vite',
    run: {
      activity: {
        links: [
          { label: 'Session', url: sessionUrl },
          { label: 'Memory', url: memoryUrl },
        ],
        target: { repository: 'acme/storefront', issue: 42 },
      },
      channelId: 'github',
      runId: schedule.runId,
    },
  },
  schedule,
})
if (error) throw error
```

The runtime publishes `queued` before capacity admission, `running` after it, `waiting` for approvals, and a terminal state on every exit. `data-agent-plan` events update the task list, so harnesses with normalized plans, such as Codex, need no GitHub code. Delivery failures are reported but never replace the Agent result.

## Reconcile GitHub pull requests

Reconcile lets PR events, such as a push, start the Agent. `pullRequest: true` accepts declared slash commands in PR comments. `pullRequest.reconcile` also starts an Invocation on the events you select. Mention commands are opt-in and app-owned, so no bot name is reserved.

```ts [server/agents/reviewer.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({
      activity: true,
      app: true,
      pullRequest: {
        reconcile: {
          concurrencyLimit: 4,
          events: ['opened', 'reopened', 'ready_for_review', 'synchronize'],
          mentions: ['@agent'],
          prompt: 'Review this pull request and make any needed changes.',
        },
      },
    }),
  },
  driver: codexDriver({ permissions: 'allow-all' }),
  workspace: { mode: 'write' },
})
```

- Each repository and PR gets `pullRequest.reconcile.concurrencyLimit` slots (default `1`). A value such as `4` runs up to four deliveries for one PR. Keep `1` for tasks that write the same branch.
- Bot `synchronize` events are ignored, so a bot push never restarts the bot.
- Slash commands still work.
- Reconciliation only starts work. Merge rules and human consent stay in your instructions or Capabilities.
- Queued reconciliation reloads the PR head, comments, and files before the Driver starts.
- Eligibility is decided on acceptance and kept while the delivery waits.

### Hosted CI

`pullRequest.ci` tells the run what to do with hosted CI after it pushes:

- `'report'` (default): the Agent runs the project's local checks before it pushes, then reports the hosted checks that are still pending and finishes. The run does not wait for CI.
- `'wait'`: the Agent waits for hosted CI after it pushes and fixes failures until all checks pass. The run stays open, and its tokens and time are spent, until CI finishes. Use it only when the Agent must see green checks before it finishes, and set a [deadline](#deadline) that covers your CI time.

```ts [server/agents/reviewer.ts] fragment
github({ app: true, pullRequest: { ci: 'wait', reconcile: { mentions: ['@agent'] } } })
```

Reconcile does not start a run on a failed check. To fix CI failures, ask the Agent in a comment, or let a workflow post a comment on failure that `reconcile.comments` accepts. Mention triggers skip bot comments.

### Deadline

Persisted inline webhook runs time out after 15 minutes by default. Set `messages.timeout` in milliseconds, such as `30 * 60_000`. A timeout on the persisted input wins. Values must be positive, finite, and at most `2_147_483_647`, or the default applies. Replayed or rehydrated input can change the deadline after setup, minus setup time already spent, but setup keeps the first deadline. The deadline includes Workspace preparation, and expiry cancels the Invocation.

### Skip and group review bot deliveries

Review bots often post on every push, even with no findings. List those body prefixes in a trigger's `noFindingsReviews`, such as `['> ✅ No new issues found.']`, and matching `commented` reviews do not match the trigger. Set `debounceMs` to delay delivery: a later delivery from the same trigger and PR replaces a queued one, so a burst starts one Invocation. Other triggers' deliveries, such as mention commands, are never replaced, and running deliveries never stop.

### Pull request Workspace

The Workspace (the Agent's files) gets the PR checkout at `pullRequest.workspace.mount`. Without `workspace`, the mount is `portal`. `workspace: true` and `workspace: {}` mount at the root. `workspace: false` turns it off.

With the Workspace, the Channel also adds the `vitehub-resolving-merge-conflicts` Skill at `.agents/skills/vitehub-resolving-merge-conflicts/SKILL.md`, and the prompt tells the Agent to use it for merge and rebase conflicts. Without the Workspace, the prompt gives the same steps in one line.

The checkout uses the exact head SHA, so the PR loads before the Invocation starts. If that fails, the delivery fails with `AGENT_R0370` and the GitHub error, such as a connection reset, 401, or 404. With `workspace: false`, PR details are best effort: a failure leaves them out and sets `pullRequest.metadata.unavailable`.

::warning
Only queued deliveries retry automatically. A first metadata failure happens before admission and needs redelivery, which GitHub does not do on its own. With durable webhook State and acknowledgement, the inbox replays failed admissions at startup, not while the process runs. See [Answer slow webhooks early](#answer-slow-webhooks-early).
::

A GitHub Source is a repository declared as Workspace files. One with the same repository and non-root mount is replaced by the PR checkout for that Invocation, reading the head SHA, and stays unchanged for others. Different repositories, overlapping parent or child mounts, and Sources from other Capabilities still conflict.

### Forge access for Git and Drivers

A github() Channel with `app` gives its Agent forge access (GitHub repository access) for the PR checkout, the [`git()`](/docs/agents/capabilities/git) and `forge()` Capabilities, and provider Drivers, which get `GH_TOKEN`, `GITHUB_TOKEN`, and Git credentials before `driver.env`.

Each repository gets one token: `app.token` if set, else an App installation token from the `app` options or Server Env (`VITEHUB_GITHUB_APP_ID`, `VITEHUB_GITHUB_PRIVATE_KEY`, optional `VITEHUB_GITHUB_INSTALLATION_ID`), else `VITEHUB_GITHUB_TOKEN`. Without a fixed installation, the App finds the repository's.

Git credentials come from `forgeGitCredentials()` and `forgeGitAuthHeader()` in [`@vite-hub/forge`](/docs/forge/server-api#public-imports), in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, never in arguments. They reach only the PR base and head repositories. A run without a PR, such as Teams or chat, gets credentials for the Agent's reachable GitHub Workspace Sources so it can clone them, and none without Sources. An Agent with two github() Channels that set `app` gets no forge access.

```ts [server/agents/reviewer.ts] fragment
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({
      app: { token: async (_context, { repository }) => await vault.githubToken(repository) },
      pullRequest: true,
    }),
  },
  driver: codexDriver(),
  workspace: { mode: 'write' },
})
```

## Connect a web chat

`webChat()` adds a chat route at `/api/_vitehub/agents/[agent]/chat`. Set `route: false` to keep the Agent off this shared route. Turn on Agents in the config:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node', agent: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', agent: true }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', agent: true }),
  ],
})
```
:::
::

Use the Vue client from the application:

```vue [app/components/SupportChat.vue]
<script setup lang="ts">
import { useAgent, useChat } from 'vite-hub/agent/vue'

const agent = useAgent('support')
const { messages, status, sendMessage, stop } = useChat(agent)
</script>
```

`useChat()` also gives a reactive `invocationId`, set when the route accepts a request. Link to the run in the Console with it: pass the path `/agents/~support/invocations/<invocationId>` to `hostedConsoleUrl()` from `vite-hub/runtime`. See [Links to the Console](/docs/development/console#links-to-the-console).

`route.admission.authenticate` requires authentication. ViteHub reads the raw body once, verifies the UI-message format, and after authentication copies only the fields that `route.input.trust` names.

Chat and webhook routes accept at most 1 MiB by default. `route.maxBodyBytes` lowers it, or raises it up to 10 MiB for larger JSON. Both `Content-Length` and streamed bytes are checked, so chunked requests cannot exceed it.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat({
      route: {
        admission: {
          authenticate({ rawBody, request }) {
            verifyPortalSignature(rawBody, request.headers.get('x-portal-signature'))
            return { customer: request.headers.get('x-customer') }
          },
        },
        input: { trust: ['meta', 'user', 'session'] },
      },
    }),
  },
  driver: { run: () => 'ok' },
})
```

If the shared route does not fit your rules, write your own with [`streamAgentTrigger()`](/docs/agents/triggers#consume-a-capability-trigger).

### Resume a web chat in one process

A browser can reconnect to an active response. Set `resume: true` in `useChat()` and `resumable` with process scope on the route.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat({
      route: {
        admission: {
          authenticate: ({ request }) => requireSession(request),
        },
        resumable: {
          owner: ({ auth }) => auth.user.id,
          scope: 'process',
          ttlMs: 10 * 60 * 1000,
        },
      },
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The route drops a repeated submission from the same owner, replays the buffered stream, follows the live response, and keeps a completed one for `ttlMs`.

::warning
`scope: 'process'` means one process. Active streams die with it, and other instances cannot find them. Use it only when a chat stays on one process. Otherwise, build durable execution, stream storage, and coordination behind your own route.
::

## Connect an adapter platform

Adapter Channels connect Discord, Slack, Teams, Telegram, and similar platforms through a Chat SDK adapter. They deliver the completed response by default. Set `messages.stream: true` on the Agent, or `messages.stream` on one Channel, to publish draft and edit updates while the Agent writes.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { discord } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    discord: discord({
      adapter: {
        botToken: process.env.DISCORD_BOT_TOKEN,
        publicKey: process.env.DISCORD_PUBLIC_KEY,
      },
      messages: { lockScope: 'thread' },
    }),
  },
  driver: { run: () => 'Hello from ViteHub.' },
})
```

Install the matching `@chat-adapter/*` package when a built-in Channel uses adapter options, and keep credentials in Server Env. For a full bot with setup, testing, and deployment, follow the guide for [Slack](/docs/guides/slack-ai-bot), [Discord](/docs/guides/discord-ai-bot), or [Telegram](/docs/guides/telegram-ai-bot).

### Channel Env

Built-in Channels read credentials from Server Env (the server environment that ViteHub manages) under `env.server.<channel>`. ViteHub finds Channel factories in Agent files and declares their fields, so most apps declare nothing. Passed options beat Env values. Declare a field yourself for a non-default variable name or provider.

Each field reads its canonical name first (`VITEHUB_` plus the path in upper snake case), then vendor names. `telegram()` reads `VITEHUB_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`. `github()`, `gitlab()`, and `forgejo()` then read the `FORGES_` name of the [`forges`](https://forges.link/reference/environment-variables) library, such as `FORGES_GITHUB_TOKEN`, but never `GH_TOKEN` or `GITHUB_TOKEN`. In GitHub Actions, set `VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

See [Server Env variable names](/docs/env/configure).

`teams()` always builds its adapter from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, and `TEAMS_API_URL` in `env.server.teams`, so it needs no credential options. Pass `adapter` options such as `userName` or `appType`, or your own adapter or factory. Install `@chat-adapter/teams`.

```ts [server/agents/support.ts] fragment
teams({ adapter: { userName: 'Support' } })
```

[Server Env](/docs/env) shows the discovered fields and whether each is required or secret. Declare fields yourself for a Channel outside a discovered Agent file.

For Telegram, ViteHub can own the verified webhook route and register it after deploy:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { telegram } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    telegram: telegram({ allowedUserIds: ['123'] }),
  },
  driver: { run: () => 'Hello from ViteHub.' },
})
```

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --agent support \
  --channel telegram \
  --json
```

The command is a dry run by default. Apply a reviewed plan with `--apply` and the exact `--confirm-origin`. See [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks) for the safeguards on deletion and secrets.

## Control admission and delivery

Admission decides which messages start the Agent. Delivery decides how replies return.

Direct conversations need no mention. Groups, channels, and shared chats need a mention on every message, unless `messages.replyToSubscribedThreads` lets a subscribed thread accept unmentioned human replies. Unmentioned messages from bots or unsubscribed threads stay ignored. The same rules apply to queued messages and steering.

`messages.filter` adds your own rules before an Invocation. When it returns `false`, no loading message or fallback error is posted, because the Agent never started. Accepted deliveries have `deliveryKind` `'direct'`, `'mention'`, or `'subscribed'` (unmentioned human replies accepted by `messages.replyToSubscribedThreads`).

Set `messages.meta` to a Standard Schema to validate Channel metadata before Capabilities, hooks, or the Driver run. It can normalize or add defaults, but must output an object. Set a stable `metaRevision` and change it with the schema, so durable Workflows reuse the parsed metadata across processes instead of validating again. Both go in the shared Agent message settings or on one Channel as an override.

```ts
import { defineAgent } from 'vite-hub/agent'
import * as v from 'valibot'

export default defineAgent({
  driver: { run: ({ context }) => context.get('channel')?.meta },
  messages: {
    meta: v.object({ audience: v.optional(v.picklist(['support', 'technical'])) }),
    metaRevision: '1',
  },
})
```

Set `messages.commentary: 'message'` only when the Driver emits explicit commentary phases for public progress. Commentary is hidden by default, and reasoning is never published.

Use `messages.delivery: 'manual'` when finish hooks send replies. A generated Workflow can carry it across a durable boundary when the Channel and host support it. An explicit `messages.timeout` limits inline execution and the handoff's typing indicator, not the durable Workflow. `steer` queues overlapping messages and keeps the handoff. `serial`, `drop`, `queue`, and `reject` stay inline and cannot combine with required durable delivery.

With native reply support in the adapter (Telegram among the built-ins), a non-streamed reply quotes the starting message, so the user sees which photo or question it answers. Inline, finish hook, and durable Workflow delivery all follow this. Streamed replies, retries after a restart, and adapters without native replies post a new thread message. History and custody record the reply like any other message.

`messages.loading` shows a progress message that ViteHub edits while the Agent works:

- `text` (required): a string, rotating strings, a callback, or `null`.
- `intervalMs`: minimum time between updates.
- `updates: 'commentary'`: shows explicit commentary, each part replacing the last, so the current step is visible.
- It selects manual delivery, so it excludes `messages.stream` and `messages.commentary`.
- `messages.final.delivery: 'new-message'` posts the answer separately, then removes the placeholder.

```ts fragment
messages: {
  loading: {
    text: ['Looking into it…', 'Still working…'],
    intervalMs: 1_500,
    updates: 'commentary',
  },
  final: { delivery: 'new-message' },
}
```

Some group messages need no answer. `messages.allowSilentReply: true` gives the Agent a `skip_reply` tool. Called with a short reason, it ends the Invocation without the final reply and removes the loading message. Errors still post, and sent messages stay. It needs `messages.loading` and excludes `delivery: 'manual'`, because only a held-back final reply can be skipped.

```ts fragment
messages: {
  allowSilentReply: true,
  final: { delivery: 'placeholder' },
  loading: { text: 'Thinking…' },
}
```

The skip is recorded as a final reply effect with `channel.effect.skipped: "skip_reply: <reason>"`, listed under `deliveries` by `vitehub agent invocations export`.

## Inspect delivery custody

Delivery custody shows what happened to each incoming message, so you can find where one was lost. Every Agent Channel records a timeline before the Agent starts: the provider event id, separate from ViteHub's delivery id, then admission, Invocation, retry, outbound, completion, and failure events. Discord Gateway and Telegram polling listeners also emit lifecycle events, so a listener gap is distinguishable from an event that arrived.

::note
No ViteHub record can prove a provider event that never reached the process. Use provider audit logs and Gateway session history for that.
::

Timelines live in the Channel's State Adapter, for the 10,000 most recent admissions. Inspection merges concurrent or retried admissions of one timeline. Each delivery and its newest 256 events expire 30 days after the last update. Records hold identifiers, timestamps, attempts, provider reply ids, and size-limited error messages, never message text, attachment data, webhook bodies, or connector options. They are as durable as the Agent state provider. The default in-memory dev state stays in one process.

Hooks and Drivers get the active record as `context.channelDelivery`. Trace Events repeat `channel.delivery.id`, `channel.delivery.provider`, and `channel.delivery.source.id`. JSON logs use the `vitehub.channel.delivery` and `vitehub.channel.listener` scopes. Host integrations read records with the webhook handler's `handler.deliveries(request, webhookId, options)`, through the Channel's scoped State Adapter.

## Scope abilities to one Channel

A Capability gives the Agent an ability, such as API tools. Channel Capabilities apply only when that Channel is active. Agent-level ones apply to every Invocation.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { openapi } from 'vite-hub/agent/capabilities'
import { teams, webChat } from 'vite-hub/agent/channels'

const portalApi = openapi({
  cli: { name: 'portal-api' },
  operations: ['purchaseOrders'],
  spec: 'https://portal.example.com/_openapi.json',
})

export default defineAgent({
  channels: {
    portal: webChat({ capabilities: [portalApi] }),
    teams: teams(),
  },
  driver: { run: () => 'ok' },
})
```

Channel-scoped Capabilities select abilities, not identity. Authenticate and resolve the Invoker at the route, trigger, or `access()` boundary.

## Add instructions to one Channel

Channel `instructions` apply only to Invocations that the Channel starts. They come after the Agent instructions and after built-in formatting rules, such as those of `teams()` and `telegram()`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({
      instructions: 'Review only the files that the pull request changes. Link each finding to its line.',
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

They are trusted text from code, read when the Invocation runs, so queued deliveries use the current text. Direct `runAgent()` calls and `run` Drivers do not get them. Inspection lists them as `Channel "<name>" instructions`.

## Handle attachments

Adapter Channels keep incoming images, audio, and files as typed message parts. Attachments on the message being answered are current Agent input. History attachments are not, so old media is not downloaded again, and the header marks each `(not shown)`. To resend recent history photos, set [`triggerHistory.maxImages`](/docs/agents/chat-history-sessions#send-recent-history-photos).

Every Channel that gives normalized `replyTo.attachments` gets this. Thread ids, link previews, and URLs in text are not reply content and are never resolved. If a provider does not normalize its native reply into `replyTo`, fix its adapter instead of guessing a thread root in the Agent.

### Attachments in model-backed Drivers

A model-backed Driver sends inline data and adapter-owned `fetchData` to the model within one Invocation budget, 25 MiB by default, lowered with `driver.execution.attachments.maxBytes`. A URL-only attachment stays a typed reference that the server never fetches. Resolve private files in the Channel adapter, so its authentication, destination checks, timeouts, and size limits apply.

### Attachments in provider-backed Drivers

A provider-backed Driver (a coding agent such as Codex or Claude Code) materializes inline data and app-owned `fetchData` results for the provider. The app must validate and resolve URL-only attachments through `fetchData`, because the Driver fetches no URL from the host. With adapter-owned content, provider download URLs and rehydration metadata are removed, so signed URLs stay out of durable Workflow input.

### Attachments in the history export

History export archives inline data, sized adapter-owned `fetchData`, and Blob data, up to 25 MiB of attachments and 35 MiB in total.

- A lazy adapter read needs a trustworthy non-negative `size` within the remaining budget.
- URL-only attachments stay unavailable, because the server cannot guess which hosts you trust. Store their bytes through the adapter to keep them.
- The export stops waiting for each provider or adapter read after 30 seconds or on abort. Chat SDK history and `fetchData` cannot be cancelled, so the adapter's I/O can finish later.
- Attachments over budget, malformed, failing rehydration, unsized for a lazy read, or otherwise unreadable stay in `history.json` as unavailable references.
- The export fails rather than exceed its total limit.

## Separate responsibilities

| Concern | Owner |
| --- | --- |
| Origin, event, thread, message, custody, and reply delivery | Channel |
| Trusted caller identity | Agent Invoker |
| User-authored command parsing | Input Commands Capability |
| Prior conversational messages | Chat History and sessions |
| Product event to Agent input | Trigger |

## Channels and Invocations

A Channel and an Invocation are separate records, so one Agent can run behind several Channels.

| | Channel | Agent Invocation |
| --- | --- | --- |
| Describes | Message origin and delivery | Invoker, Capabilities, execution, and result |
| Lifetime | Can contain many messages and Invocations | One request |
| Can exist alone | Yes. A Channel can receive a message without starting an Agent. | Yes. A route or schedule can start an Invocation without a Channel. |

Use verified Channel metadata to identify the Agent Invoker, choose a Capability, or select a Workspace Scope. When a message reaches the wrong Agent, carries the wrong identity, or loses delivery data, inspect the Channel and the [Invocation](/docs/agents/invocations) together.

To send an application message without an Agent, use the [Channels Server Primitive](/docs/channels).

## Next steps

Follow [Build a chat app](/docs/agents/build-a-chat-app) for a complete web client, and [Chat History and sessions](/docs/agents/chat-history-sessions) to choose which prior messages reach the model. Inspect results with [Observability](/docs/agents/observability) and [Test an Agent](/docs/agents/testing).
