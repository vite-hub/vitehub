---
title: Channels
description: Connect an Agent to web chat and messaging platforms without mixing transport with identity.
navigation.order: 40
navigation.group: Connect
icon: i-lucide-radio
---

A Channel describes where an Agent Invocation came from and how replies return there. It carries transport, event, thread, message, and delivery facts. It does not prove who the caller is.

Use [Agent Actors](/docs/agents/actors) for trusted identity and [Input Commands](/docs/agents/capabilities/input-commands) for explicit command handling.

## Supported channels

ViteHub includes these Channel helpers. Each one connects an incoming message or event to an Agent Invocation. Configure provider credentials and permissions before using it.

::supported-channels
::

Use `defineChannel()` when your application needs another transport. For outbound delivery without starting an Invocation, use [Channels](/docs/channels).

## Add a Channel

Import Channel helpers from `@vite-hub/agent/channels`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { github, webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat(),
    github: github({ pullRequest: true }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Built-in helpers include `discord()`, `github()`, [`gitlab()` and `forgejo()`](/docs/agents/code-host-channels), [`gmail()`](/docs/agents/gmail), `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()`. Use `defineChannel()` for an application-owned Channel Kind.

`teams()` instructs the Agent to cite sources with descriptive Markdown links to verified URLs. Chat SDK Channel delivery labels unresolved native web citations as `[source link unavailable]`, including during streaming. Codex app-server does not supply a citation-ID-to-URL map, so ViteHub cannot recover those links from the IDs. Ordinary source links remain intact.

`webChat()` enables a generated AI SDK chat route by default. `http()` is a generic HTTP Channel and keeps its route disabled unless you pass `http({ route: true })`.

## Answer replies in subscribed threads

Built-in chat Channels require a mention for channel messages by default. Set
`messages.replyToSubscribedThreads: true` on the Agent or an individual Channel
to also answer human messages in subscribed threads:

```ts
teams({
  messages: {
    replyToSubscribedThreads: true,
  },
})
```

Mentions subscribe a conversation through the Agent's chat state. A host that
creates bot threads must subscribe those threads through the same state store.
This setting does not subscribe every channel conversation. It ignores
unmentioned messages in other threads and unmentioned messages sent by other bots.
Direct messages and mentions keep their existing behavior.

Message filters receive `deliveryKind: 'subscribed'` for these replies. All
concurrency modes use the same admission policy. The provider must deliver the
messages first. For Teams, the Team app installation needs channel-message read
permission and consent.

## Act on the Channel message in hooks

The Channel defines the connector. The Agent reacts in its hooks. `agent:finish` and `agent:error` hooks receive `event.message`, a handle for the Channel message that started the Invocation.

Declare the handle's methods with `defineChannel(kind, { message })`. The Trigger returns JSON `message` data that identifies the provider message. Each method receives the Channel context first. `context.message` is the Trigger's data, validated by the `message.data` Standard Schema when you set one.

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { defineChannel, defineChannelTrigger } from 'vite-hub/agent/channels'
import * as v from 'valibot'
import { applyLabels, readEmail } from '../lib/mailbox'

const mailbox = defineChannel('mailbox', {
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

`event.message` has these properties:

| Property | Value |
| --- | --- |
| `channel` | The Channel name in the Agent's `channels` map. |
| `kind` | The Channel Kind, such as `'mailbox'` or `'telegram'`. |
| `data` | The Trigger's `message` data, typed by `message.data`. |
| Methods | One async function per method, without the context argument. |

TypeScript infers the handle from the Agent's `channels`. With several Channels, `event.message` is a union that `event.message.channel` narrows. Invocations without a Channel have `event.message` set to `undefined`. The names `channel`, `data`, and `kind` are reserved.

Built-in Channels add the methods that their provider adapter supports. `discord()`, `slack()`, `teams()`, and `telegram()` provide `reply()` when an adapter is configured and messages are enabled. `github()` provides `reply()`, `reaction()`, and `status()` when it has a GitHub App. `event.reply()` still returns a reply that ViteHub delivers after the hook. For a custom Channel, a `reply` method handles it.

### Dry run

Set `dryRun: true` in the Invocation input to run an Agent against real messages without changing them. A Trigger can set it in its returned `input`; a direct caller passes it to `runAgent()`.

A method declared as a function is a write. In a dry run, ViteHub does not call write methods or built-in delivery, including the automatic reply. It records each call as a skipped delivery in the Invocation trace, and the call returns `undefined`. Methods declared as `{ read: true, handler }` still run.

The Console shows the recorded call, such as `label(["Receipts"])`. The call text is Invocation content. A stored Invocation keeps it only with `content: 'content'` or when `metadataContent` lists `channel.effect.content`. The Console store lists it.

## Webhook paths

On Nitro hosts, a Channel's `webhooks.path` is served alongside its built-in `/api/_vitehub/agents/:agent/webhooks/:webhook` route. Both paths use the same handler, authentication, HEAD probe, and Channel history export. Other application routes keep their request body.

If several Agents declare the same path, their configured `publicUrl` hosts select the Agent for the request host. You can also set `agent.routes.aliases[path]` to `{ agent, webhook }` to select its owner explicitly. If ownership remains ambiguous, the declared path returns HTTP 409 instead of dispatching to an arbitrary Agent.

## Replay Channel history

Add `history` to a Channel to run an Agent on messages that arrived before the Agent existed, or to run them again after a change. `history.collection` is a [Collection](/docs/source/server-api#expose-a-typed-collection). Each item has the shape of the Channel trigger input, so a replayed message takes the same trigger path as a live one. `history.key` returns a stable key for each item, such as the provider message ID. Optional `history.thread` returns its conversation ID. `vitehub channels history` uses this Collection for custom Channels and accepts `--thread`, repeatable `--query key=value`, and `--invocations`.

To join legacy Invocations without `vitehub.channel.key`, add `history.invocationItem(invocation): TItem | undefined | Promise<TItem | undefined>`. This read-only hook receives the retained `AgentInvocationRecord` and reconstructs an item for `key()` and optional `thread()`. Existing key annotations take precedence. The journal does not retain raw trigger input or `input.context`, so return `undefined` when observations and annotations cannot identify the item. Hook errors also leave the record unjoined.

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { defineChannel, defineChannelTrigger } from 'vite-hub/agent/channels'
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

const mailbox = defineChannel('mailbox', {
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

Set `history.trigger` when the Channel has more than one trigger. Replay the history from the terminal with [`vitehub channels replay`](/docs/development/cli#download-channel-history):

```sh
pnpm vitehub channels replay --agent labeller --channel mailbox --folder archive --dry-run
```

Or call `replayChannel()` from trusted server code:

```ts [server/api/backfill.post.ts]
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

Use `--label <label>` to group replayed Invocations by the `triggeredBy` annotation. Labels must be non-empty and at most 512 characters. Repeatable `--query key=value` is an alias for `--filter key=value`. The label stays outside the Collection query; to filter a query field named `label`, use `--query label=value`. The programmatic option is `replayChannel(agent, channel, { label })`. Forced rounds get separate Invocation IDs and labels, while unlabeled replay keeps its existing behavior.

With the Console enabled, the Vite development loop inherits its configured Invocation journal, including definitions authored with `@vite-hub/agent`. Local dry-run replays need no app-side Invocation configuration.

Authenticated replay uses the saved history item without requiring the provider webhook signature again. Live webhooks still verify their signatures and replayed input still passes trigger schema validation.

`replayChannel()` validates `query` with the Collection's query schema, then reads pages until it reaches `limit` or the end of the history. It returns `processed`, `skipped`, and `failed` counts, one entry per item, and `nextCursor`. Pass `nextCursor` as `cursor` to continue. It is `null` when no history remains.

An unconfirmed pending Invocation held by another claim reports a retryable failure. Workflow dispatch records its attempt before calling the provider. If recovery cannot observe that run, the Invocation stays pending and reports a retryable failure; a later replay checks the provider again. A provider status of `unknown` does not prove that an attempted dispatch was rejected. A reservation that records no dispatch attempt can be recovered after its claim expires. Older journals without this marker remain pending while provider status is unknown. Use `force` only when you intend to start a separate Invocation with a fresh ID. Running Invocations and confirmed Workflow dispatches are skipped. Replay also checks journals created with the earlier `channel-replay:<channel>:<key>` IDs before starting a new Invocation.

Each item gets the Invocation run ID `channel:<channel>:<key>`; percent signs and colons in each component are escaped. Replay skips terminal Invocations and confirmed Workflow dispatches. An active claim prevents concurrent execution of the same item. Inline runs remain recoverable until their terminal status is stored; after process loss, a retry can claim the item when the lease expires. A live message that a trigger [dispatches](#start-several-invocations-from-one-webhook) with the same key has the same ID. This needs an Invocation journal: configure `invocations` or enable the [Console](/docs/development/console). Pass `force: true` to replay handled items again; each forced item gets a new ID. Pass `dryRun: true` to [record Channel message writes](#dry-run) instead of sending them. Dry runs use `channel-dry-run:` IDs, so they never block a later live replay.

An inline Agent runs each item before it reads the next one and reports it as `completed`. An Agent with a [Workflow runtime](/docs/agents/invocations) starts one durable Workflow run per item and reports it as `started`. A trigger error, such as invalid item input, marks that item `failed`, and replay continues.

[`gmail()`](/docs/agents/gmail#replay-past-mail) provides `history` from a Gmail search. The other built-in Channels do not. The Telegram Bot API cannot read past messages. Slack, Discord, Teams, and GitHub history are not built in; define a custom Channel with a history Collection when you need them.

### Start several Invocations from one webhook

Some providers send one webhook for several messages. A Channel trigger can answer the webhook itself and call `context.dispatch(items, { trigger })` to start one Invocation per item through another trigger of the same Channel. Each item has an `input` for that trigger and a `key`. Dispatched items get the same Invocation IDs as a replay, so an item that already has an Invocation is skipped.

On a webhook delivery, `context.channelState` gives the trigger the Channel's State Adapter. Store provider cursors under `context.channelState.keyPrefix`.

```ts
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

Set `webhooks: []` on the trigger that only receives dispatched items, so the Channel's webhook route does not reach it.

## Publish Agent activity without opening a chat

Enable `activity` when an invocation should project its lifecycle into a Channel without treating that Channel as the Agent's conversation transport. With GitHub App webhooks enabled, ViteHub creates the authenticated app-owned comment on `pull_request.opened` unless `pullRequest.reconcile.events` explicitly excludes `opened`; later invocations reuse it. If that event is excluded, the first later invocation creates the comment. The comment claims work with a “Starting” row. One table lists the current and recent sessions, newest first, with links, status, GitHub relative start times, and completed durations. Normalized harness task checkboxes and the newest available session's final answer appear below it. All session answers stay in one collapsed section, newest first, with one session link and one paragraph per answer. The full transcript stays in the linked session when one is configured.

Enable the GitHub App webhook for `pull_request` events and route it to the Agent’s generated webhook endpoint to claim the comment when the PR opens, unless `pullRequest.reconcile.events` explicitly excludes `opened`. If it is excluded or the webhook is not delivered, the first later invocation creates the comment.

Activity updates are ordered within one process. Across concurrent hosts, GitHub delivery is best-effort: intermediate updates can coalesce, separate hosts can temporarily create duplicate managed comments, and overlapping writes can briefly replace newer state. A later update reconciles owned duplicates and stale state when possible. Within one process, older updates do not replace the current or terminal run.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export const agent = defineAgent({
  channels: {
    github: github({
      activity: { publicUrl: 'https://agent.example.com' },
      app: true,
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Set `activity.publicUrl` to the public origin of the Agent's ViteHub Console. GitHub pull request webhook runs then receive a link to their own invocation as soon as they start. Use `activity: true` when the application supplies activity links itself.

Select the Channel and its destination when the application starts the invocation. Links are application-owned; use them for the current session, memory, or another inspection surface.

```ts
import { runAgent } from 'vite-hub/agent'

await runAgent(agent, {
  memo: (_key, create) => create(),
  runtime: 'vite',
  waitUntil: schedule.waitUntil ?? (() => {}),
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
}, { prompt: 'Converge this pull request.' }, { schedule, output: 'drained' })
```

The runtime publishes `queued` before capacity admission, `running` after admission, `waiting` for approval requests, and a terminal state on every exit. `data-agent-plan` stream events update the task list, so Codex and other harnesses that expose normalized plans do not need provider-specific GitHub code. Activity delivery failures are reported without replacing the Agent result.

## Reconcile GitHub pull requests

`pullRequest: true` accepts declared slash commands on pull request comments. Add `pullRequest.reconcile` when selected pull request lifecycle events should also start an invocation. Mention commands are opt-in and application-owned, so ViteHub does not reserve a bot name.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
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
  driver: { kind: 'codex', permissions: 'allow-all' },
  workspace: { mode: 'write' },
})
```

Reconciled deliveries use `pullRequest.reconcile.concurrencyLimit` concurrent invocation slots per repository and pull request. The default is `1`. Set a positive integer such as `4` to allow up to four deliveries for the same pull request to run together. Other pull requests have separate limits. ViteHub ignores bot-authored `synchronize` events to prevent a bot push from immediately triggering itself. Existing slash commands still work when reconciliation is enabled. Reconciliation starts work; merge policy and any required human consent remain application-owned instructions or Capabilities.

Persisted inline webhook executions have a 15-minute default deadline. Set `messages.timeout` in milliseconds to change it, for example `30 * 60_000`. A timeout on the persisted Invocation input takes precedence. The selected timeout must be positive, finite, and at most `2_147_483_647` milliseconds; invalid values use the 15-minute default. Replayed or rehydrated Invocation input can override the deadline after setup, with elapsed setup time deducted. Setup remains bounded by the initial deadline. The deadline includes workspace preparation and cancels the Invocation when it expires.

Queued GitHub reconciliation reloads the PR head, comments, and files before the Driver starts, so each Invocation uses the current PR state. Eligibility is decided when the delivery is accepted and is preserved while queued. Use the default `concurrencyLimit: 1` for tasks that write to the same PR branch.

Set `pullRequest.workspace.mount` to the repository path inside the Workspace. Omitting `workspace` mounts at `portal`. Both `workspace: true` and `workspace: {}` mount at the Workspace root. Set `workspace: false` to disable the pull request Workspace contribution.

When a declared GitHub Source uses the same repository and the same non-root mount, the pull request checkout replaces it for that Invocation. Reads use the pull request head SHA; the declared Source remains unchanged for other Invocations. Different repositories, overlapping parent or child mounts, and Sources contributed by other Capabilities still produce a conflict.

## Connect a web chat

`webChat()` exposes the Agent through `/api/_vitehub/agents/[agent]/chat`. Set `route: false` to keep that Agent unreachable through the shared dispatcher.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', agent: true }),
  ],
})
```

Use the Vue client from the application:

```vue [app/components/SupportChat.vue]
<script setup lang="ts">
import { useAgent, useChat } from 'vite-hub/agent/vue'

const agent = useAgent('support')
const { messages, status, sendMessage, stop } = useChat(agent)
</script>
```

`useChat()` also exposes a reactive `invocationId`. It is populated when the generated route accepts a request so an application can link to `/_vitehub/agents/~support/invocations/${invocationId.value}`.

Add `route.admission.authenticate` when the generated route needs authentication. ViteHub reads the raw body once, verifies the shared UI-message contract, and copies only fields named in `route.input.trust` after authentication.

Agent chat and webhook routes accept at most 1 MiB by default. Set `route.maxBodyBytes` to a smaller limit or raise it as high as 10 MiB for a web chat with larger JSON payloads. ViteHub checks `Content-Length` and the streamed byte count, so chunked requests cannot bypass the limit.

```ts [server/agents/support.ts]
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

Use an application-owned route and [`streamAgentTrigger()`](/docs/agents/triggers#consume-a-capability-trigger) when the shared dispatcher is not the right authentication or request boundary.

### Resume a web chat in one process

Set `resume: true` in `useChat()` and opt the generated route into process-scoped replay when a browser should follow an active response after reconnecting.

```ts [server/agents/support.ts]
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

The route de-duplicates one owner's repeated submission, replays buffered UI-message stream bytes, follows the live response, and retains a completed response for `ttlMs`. `scope: 'process'` is literal: active streams do not survive process replacement and cannot be discovered by another instance. Use this only where deployment keeps a chat on one process, or put durable execution, stream storage, and coordination behind an application-owned route.

## Connect an adapter platform

Adapter-backed Channels deliver the completed response by default. Set Agent-level `messages.stream: true` to publish draft and edit updates everywhere, or set `messages.stream` on one Channel.

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

Install the matching `@chat-adapter/*` package when a built-in Channel uses provider adapter options. Keep provider credentials in Server Env.

### Channel Env

Built-in Channels read credentials from Server Env under `env.server.<channel>`. ViteHub discovers built-in Channel factories in Agent definitions and declares their fields automatically, so applications usually need no separate Env declaration. Explicit Channel options take precedence over Env values. Declare a field yourself when the host variable name or provider differs from the default.

Each field first reads its canonical name, `VITEHUB_` and the path in upper snake case, then its vendor names. `telegram()` reads `VITEHUB_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`. Use the canonical name when the vendor name is taken, for example `VITEHUB_GITHUB_TOKEN` in CI. See [Server Env variable names](/docs/env/configure).

Use [Server Env](/docs/env) to inspect the discovered fields and their required or secret status. When a Channel is defined outside a discovered Agent file, declare its Env fields explicitly.

For Telegram, ViteHub can own the verified webhook route and synchronize it after deployment:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  channels: {
    telegram: { allowedUserIds: ['123'] },
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

The command is a dry run by default. Apply a reviewed plan with `--apply` and the exact `--confirm-origin`; see [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks) for deletion and secret safeguards.

## Control admission and delivery

Adapter-backed Channels accept messages without a mention in a direct conversation with the Agent. By default, group conversations, channels, and shared chats between people require an explicit Agent mention on every message. When `messages.replyToSubscribedThreads` is `true`, a current thread subscription also permits unmentioned human replies. Unmentioned messages from other bots or unsubscribed threads remain ignored. The same rule applies to queued messages and steering an active invocation.

Use `messages.filter` to add application-specific restrictions before an invocation starts. Returning `false` posts no loading message or fallback error because the Agent never started. Accepted deliveries have `deliveryKind: 'direct'`, `deliveryKind: 'mention'`, or `deliveryKind: 'subscribed'`. The `subscribed` kind identifies unmentioned human replies admitted by `messages.replyToSubscribedThreads`.

Set `messages.meta` to a Standard Schema when application-owned Channel metadata must be validated before Capabilities, hooks, or the Driver run. The schema may normalize or add defaults, but its output must be an object. Set `metaRevision` to a stable value and change it whenever the schema contract changes so durable Agent Workflows can reuse parsed metadata across processes. Without a revision, durable execution validates the metadata again. Put both settings on shared Agent message settings or on one Channel to override them for that Channel.

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

Set `messages.commentary: 'message'` only when the Driver emits explicit commentary phases for public progress. Commentary is hidden by default; ViteHub never publishes reasoning as progress.

Use `messages.delivery: 'manual'` when finish hooks own replies. A generated Workflow may carry manual delivery across a durable boundary when the Channel and host support it. An explicit `messages.timeout` bounds inline execution and the durable handoff's typing indicator, but it does not cap the durable Agent Workflow. `steer` queues overlapping messages and preserves that Workflow handoff. Other overlap policies such as `serial`, `drop`, `queue`, and `reject` remain inline and cannot be combined with required durable delivery.

For a progress message that is edited while the Agent works, configure `messages.loading`. Its required `text` accepts a string, rotating string array, callback, or `null`; `intervalMs` controls the minimum update interval. Set `updates: 'commentary'` to project explicit commentary text into that message. `messages.loading` selects manual delivery, so it cannot be combined with `messages.stream` or `messages.commentary`. Set `messages.final.delivery: 'new-message'` to post the final answer separately and then remove the loading placeholder.

```ts
messages: {
  loading: {
    text: ['Looking into it…', 'Still working…'],
    intervalMs: 1_500,
    updates: 'commentary',
  },
  final: { delivery: 'new-message' },
}
```

## Inspect delivery custody

Every built-in and custom Agent Channel records a delivery timeline before the Agent starts. The record keeps the provider event id separate from ViteHub's delivery id, then appends admission, invocation, retry, outbound, completion, and failure events. Discord Gateway and Telegram polling listeners also emit structured lifecycle events, so a listener gap can be distinguished from an event that reached ViteHub.

The evidence boundary stays explicit: no ViteHub record can prove a provider event existed when it never reached the process. Provider audit logs and Gateway session history remain the source for that side of an incident.

The journal uses the Channel's existing State Adapter and retains the timelines referenced by the 10,000 most recent admissions. Inspection de-duplicates concurrent or retried admissions of the same timeline. Each delivery and its newest 256 events expire 30 days after their last update. Records contain identifiers, timestamps, attempts, provider reply ids, and bounded error messages; ViteHub does not copy message text, attachment data, webhook bodies, or connector options into the journal. Production durability therefore follows the configured Agent state provider, while the default in-memory development state remains process-local.

Invocation hooks and Drivers receive the active record as `context.channelDelivery`. Trace Events repeat `channel.delivery.id`, `channel.delivery.provider`, and `channel.delivery.source.id`, while JSON logs use the `vitehub.channel.delivery` and `vitehub.channel.listener` scopes. The webhook route handler exposes `handler.deliveries(request, webhookId, options)` so host integrations inspect records through the same scoped State Adapter used by the Channel.

## Scope abilities to one Channel

Channel Capabilities apply only when that Channel is active. Agent-level Capabilities remain available to every invocation.

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

Channel-scoped Capabilities select abilities, not identity. Authenticate and resolve the Actor at the route, trigger, or `access()` boundary.

## Handle attachments

Adapter Channels preserve incoming images, audio, and files as typed message parts. An attachment on the message selected by the current reply is also current Agent input automatically. Replies reached only through fetched history remain metadata references, so ViteHub does not repeatedly download old media.

Model-backed Drivers can consume inline data and adapter-owned `fetchData` within one invocation-wide byte budget. The default is 25 MiB; set `driver.execution.attachments.maxBytes` to lower it. A URL-only attachment remains a typed reference; ViteHub does not fetch it from the Agent server. Resolve private or provider-owned files in the Channel adapter so its authentication, destination checks, timeouts, and size limits stay in force.

This rule is adapter-neutral: every Channel that supplies normalized `replyTo.attachments` receives it without another ViteHub option. Thread ids, link previews, and URLs in message text are not reply content and are never resolved implicitly. If a provider does not normalize its native reply into `replyTo`, fix that provider adapter instead of inferring a thread root in the Agent.

Channel history export archives inline data, size-declared adapter-owned `fetchData`, and Blob data within a 25 MiB total attachment budget and a 35 MiB total response budget. Lazy adapter reads need a trustworthy non-negative `size` within the remaining budget. URL-only attachments remain unavailable references because the Agent server cannot infer an application-owned host trust policy safely. Persist their bytes through the adapter when they must be recoverable. The export stops waiting for each provider history read or adapter-owned read after 30 seconds or when its request is aborted. The Chat SDK history and `fetchData` contracts have no cancellation channel, so their underlying private I/O remains adapter-owned and may settle after the export stops waiting. Attachments that exceed the remaining budget, contain malformed retained data, fail rehydration, omit the size required for a lazy read, or otherwise cannot be read remain in `history.json` as unavailable references. The export fails instead of building an archive above its total response limit.

Provider-backed Drivers materialize inline data and application-owned `fetchData` results. URL-only attachments require the application to validate and resolve the URL through `fetchData` before crossing the provider boundary; the Driver does not fetch arbitrary URLs from the ViteHub host. Provider download URLs and rehydration metadata are removed after adapter-owned content is available so signed locators do not enter durable Workflow input.

## Separate responsibilities

| Concern | Owner |
| --- | --- |
| Origin, event, thread, message, custody, and reply delivery | Channel |
| Trusted caller identity | Agent Actor |
| User-authored command parsing | Input Commands Capability |
| Prior conversational messages | Chat History and sessions |
| Product event to Agent input | Trigger |

## Channels and Invocations

A Channel and an Agent Invocation are separate records. One Agent Definition can run behind several Channels because of this split.

| | Channel | Agent Invocation |
| --- | --- | --- |
| Describes | Message origin and delivery | Actor, Capabilities, execution, and result |
| Lifetime | Can contain many messages and Invocations | One request |
| Can exist alone | Yes. A Channel can receive a message without starting an Agent. | Yes. A route or schedule can start an Invocation without a Channel. |

Use verified Channel metadata to identify the Agent Actor, choose a Capability, or select a Workspace Scope. When a message reaches the wrong Agent, carries the wrong identity, or loses delivery data, inspect the Channel and the [Invocation](/docs/agents/invocations) together.

To send an application message without an Agent, use the [Channels Server Primitive](/docs/channels).
