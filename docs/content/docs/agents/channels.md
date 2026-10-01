---
title: Channels
description: Connect an Agent to web chat and messaging platforms without mixing transport with identity.
navigation.order: 40
navigation.group: Connect
icon: i-lucide-radio
---

A Channel describes where an Agent Invocation came from and how replies return there. It carries transport, event, thread, message, and delivery facts. It does not prove who the caller is.

Use [Agent Actors](/docs/agents/actors) for trusted identity and [Input Commands](/docs/capabilities/input-commands) for explicit command handling.

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

Built-in helpers include `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()`. Use `defineChannel()` from `vite-hub/agent/channels` for an application-owned Channel Kind. To send ordinary outbound messages without an Agent, use [`defineOutboundChannel()`](/docs/server-primitives/channels) from `vite-hub/channels`.

`webChat()` enables a generated AI SDK chat route by default. `http()` is a generic HTTP Channel and keeps its route disabled unless you pass `http({ route: true })`.

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

TypeScript infers the handle from the Agent's `channels`. With several Channels, `event.message` is a union that `event.message.channel` narrows. Invocations without a triggering Channel message have `event.message` set to `undefined`, including direct runs that use a Channel only for output delivery. The names `channel`, `data`, `kind`, and `then` are reserved.

Built-in Channels add the methods that their provider adapter supports. `discord()`, `slack()`, `teams()`, and `telegram()` provide `reply()` when an adapter is configured and messages are enabled. Built-in methods are optional in the handle type, so check availability or use `await event.message?.reply?.(text)`. `github()` provides `reply()`, `reaction()`, and `status()` when it has a GitHub App. `event.reply()` still returns a reply that ViteHub delivers after the hook. For a custom Channel, a `reply` method handles it.

The built-in helpers also accept `message: { data, methods }`. Use this option on `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, or `webChat()` to add typed methods while keeping the provider configuration. A declared method replaces a built-in method with the same name.

The generated `webChat()` route supplies the current inbound message as `{ id?, text, metadata? }`. This data comes from the request before `route.mapInput` changes the Driver messages or session selection filters the history. Use a `message.data` schema that accepts this shape.

The built-in GitHub `webhook` and `dev` Triggers supply the pull request context as message data: `{ repository, pullRequest, run, trigger }`. The `trigger.comment` field identifies the triggering comment; lifecycle events can use a synthetic comment ID. Use a schema that accepts this context. Application-owned Triggers supply their own `message` data.

### Dry run

Set `dryRun: true` in the Invocation input to run an Agent against real messages without changing them. A Trigger can set it in its returned `input`; a direct caller passes it to `runAgent()`.

A method declared as a function is a write. In a dry run, ViteHub does not call write methods or built-in delivery, including the automatic reply. It records each call as a skipped delivery in the Invocation trace, and the call returns `undefined`. Write method result types include `undefined`; check the result before using it. Methods declared as `{ read: true, handler }` still run and keep their exact result types.

The Console shows the recorded call, such as `label(["Receipts"])`. The call text is Invocation content. A stored Invocation keeps it only with `content: 'content'` or when `metadataContent` lists `channel.effect.content`. The Console store lists it.

## Replay Channel history

Add `history` to a Channel to run an Agent on messages that arrived before the Agent existed, or to run them again after a change. `history.collection` is a [Collection](/docs/server-primitives/source#expose-a-typed-collection). Each item has the shape of the Channel trigger input, so a replayed message takes the same trigger path as a live one. `history.key` returns a stable key for each item, such as the provider message ID. The built-in Channel helpers accept the same `history` options and infer the Collection item type in `history.key`.

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

Set `history.trigger` when the Channel has more than one trigger. Replay the history from the terminal with [`vitehub channels replay`](/docs/development/cli#replay-channel-history):

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

`replayChannel()` validates `query` with the Collection's query schema, then reads pages until it reaches `limit` or the end of the history. It returns `processed`, `skipped`, and `failed` counts, one entry per item, and `nextCursor`. Pass `nextCursor` as `cursor` to continue. It is `null` when no history remains.

Each item gets the Invocation run ID `channel-replay:<channel>:<key>`. Replay skips an item that already has an Invocation with that ID, so a stopped replay can run again safely. This needs an Invocation journal: configure `invocations` or enable the [Console](/docs/development/console). Pass `force: true` to replay handled items again; each forced item gets a new ID. Pass `dryRun: true` to [record Channel message writes](#dry-run) instead of sending them. Dry runs use `channel-replay-dry-run:` IDs, so they never block a later live replay.

Legacy native Vercel reservations without a `workflow` binding remain skipped because replay cannot determine whether the provider accepted them. Check the provider before using `force: true` to retry those items.

Replay persists the trigger's run metadata on the claimed Invocation before execution. Its `annotations`, `channelId`, `origin`, and `threadId` therefore appear in the journal and Console. The trigger's supplied values override inherited host metadata. A failed metadata write fails the item before Driver execution or Workflow dispatch.

Native Vercel replay retains the logical replay ID in the Invocation and stores the provider-assigned Workflow ID in `workflow`. Dispatch intent is persisted before submission. If acknowledgement is lost before a provider ID can be retained, replay reports the unknown outcome and blocks resubmission. The Workflow worker confirms its physical ID before Driver execution. Recovery and cancellation use the provider ID.

A pending replay reservation for a discovery-default Workflow requires the discovered Agent identity to recover. Without that identity, replay skips the existing item, including legacy records without Workflow metadata, because a provider run may already have been accepted. Use the host runtime context for provider reconciliation. `runtime: false` permits inline retries for trigger preparation failures when no Workflow dispatch is recorded. Inline replay must persist the running state before execution. A later replay skips that Invocation if completion persistence fails. Fresh items can still execute inline without a discovered identity.

An inline Agent runs each item before it reads the next one and reports it as `completed`. An Agent with a [Workflow runtime](/docs/agents/invocations) starts one durable Workflow run per item and reports it as `started`. A trigger error, such as invalid item input, marks that item `failed`, and replay continues.

Built-in Channels do not provide `history`. The Telegram Bot API cannot read past messages. Slack, Discord, Teams, and GitHub history are not built in; define a custom Channel with a history Collection when you need them.

## Publish Agent activity without opening a chat

Enable `activity` when an invocation should project its lifecycle into a Channel without treating that Channel as the Agent's conversation transport. With GitHub App webhooks enabled, ViteHub creates the authenticated app-owned comment on `pull_request.opened` unless `pullRequest.reconcile.events` explicitly excludes `opened`; later invocations reuse it. If that event is excluded, the first later invocation creates the comment. The comment claims work with a “Starting” row. One table lists the current and recent sessions, newest first, with links, status, GitHub relative start times, and completed durations. Normalized harness task checkboxes and the latest iteration result appear below it. Previous results stay under a collapsed section. The full transcript stays in the linked session when one is configured.

Enable the GitHub App webhook for `pull_request` events and route it to the Agent’s generated webhook endpoint to claim the comment when the PR opens, unless `pullRequest.reconcile.events` explicitly excludes `opened`. If it is excluded or the webhook is not delivered, the first later invocation creates the comment.

Activity updates are ordered within one process. Across concurrent hosts, GitHub delivery is best-effort: intermediate updates can coalesce, separate hosts can temporarily create duplicate managed comments, and overlapping writes can briefly replace newer state. A later update reconciles owned duplicates and stale state when possible. Within one process, older updates do not replace the current or terminal run.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'

export const agent = defineAgent({
  channels: {
    github: github({
      activity: true,
      app: true,
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

When `vitehub({ publicUrl })` is set, GitHub pull request webhook runs receive a link to their own Console invocation as soon as they start. Set `activity.publicUrl` to override the origin for this Channel. Without either, the run has no default link and the application can supply its own.

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

Set `pullRequest.workspace.mount` to the repository path inside the Workspace. Omitting `workspace` mounts at `portal`. Both `workspace: true` and `workspace: {}` mount at the Workspace root. Set `workspace: false` to disable the pull request Workspace contribution.

Folder Agent discovery reads these options to decide if the Agent owns a Workspace. `github({ pullRequest: false })` and `github({ pullRequest: { workspace: false } })` keep the Agent stateless, also when the Channel is exported from a relative module. Discovery rejects a `pullRequest` value that it cannot read, such as `options.pullRequest`. See [Agent Definitions](/docs/agents/agent-definitions) for the complete discovery rules.

When a declared GitHub Source uses the same repository, root, include, and ignore at the same non-root mount, the pull request checkout replaces it for that Invocation. Reads use the pull request head SHA; the declared Source remains unchanged for other Invocations. A different repository or scope at the same mount fails the Invocation with an error that names the Source. Overlapping parent or child mounts and Sources contributed by other Capabilities also produce a conflict.

For provider Drivers such as Codex and Claude Code, the mount is a real Git checkout of the exact head SHA before the Driver starts. `origin` points to the base repository, the base branch is fetched as `origin/<base>`, and a local branch named after the head branch tracks it. The Driver's own shell can run `git fetch`, `git commit`, and `git push` with the Agent GitHub identity. No token is written to the repository configuration. Checkout setup rejects a head branch without an explicit head repository, including pull requests from deleted forks.

### Share one GitHub identity

Pass a GitHub identity, such as `createGitHubHost()`, as `app`. The Channel uses it for API calls, and the Agent uses it as `defineAgent({ github })` when that option is not set. Provider Drivers receive its `access().env`: `GH_TOKEN`, `GITHUB_TOKEN`, a Git credential helper, and the commit author and committer. The pull request checkout and `git()` use the same credentials.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'
import { createGitHubHost } from 'vite-hub/agent/server/github'

const githubApp = createGitHubHost({
  identity: { login: 'reviewer[bot]', email: '123+reviewer[bot]@users.noreply.github.com' },
  credentials: () => ({
    owner: 'acme',
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
})

export default defineAgent({
  github: githubApp,
  channels: {
    github: github({ app: githubApp, pullRequest: { workspace: { mount: 'storefront' } } }),
  },
  driver: { kind: 'codex', permissions: 'allow-all' },
  workspace: { mode: 'write' },
})
```

`driver.env` values override keys from the GitHub identity. Without a GitHub identity, the checkout fetches without credentials, which works only for public repositories.

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
      adapter: true,
      messages: { lockScope: 'thread' },
    }),
  },
  driver: { run: () => 'Hello from ViteHub.' },
})
```

Install the matching `@chat-adapter/*` package when a built-in Channel uses provider adapter options. With `adapter: true`, the Discord adapter reads its credentials from the Channel Env below.

### Channel Env

Built-in Channels read their credentials from Server Env. When `vitehub({ agent })` finds a built-in Channel factory in an Agent file, it declares these values under `env.server.<channel>`. You do not need an Env block for the default names. The values appear in `#vitehub/env/server` types, `describeServerEnv()`, and the Console Env page.

| Channel | Server Env path | Host variable | Required |
| --- | --- | --- | --- |
| `telegram()` | `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | Yes, unless the Channel sets `botToken` or `adapter` |
| `telegram()` | `telegram.webhookSecret` | `TELEGRAM_WEBHOOK_SECRET_TOKEN` | No |
| `telegram()` | `telegram.apiBaseUrl` | `TELEGRAM_API_BASE_URL` | No |
| `discord()` | `discord.botToken`, `discord.publicKey`, `discord.applicationId` | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` | No |
| `github()` | `github.token` | `VITEHUB_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` | No |
| `github()` | `github.webhookSecret`, `github.appId`, `github.appInstallationId`, `github.appPrivateKey`, `github.appPrivateKeyPath` | `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH` | No |

Tokens, keys, and webhook secrets are Secret Env. On Cloudflare, a required secret is added to `wrangler.secrets.required`. A required value makes `useServerEnv()` fail when it is missing, so supply `TELEGRAM_BOT_TOKEN` in every environment that runs an Agent with `telegram()`.

An explicit Channel option always wins over Env. To use another host variable, declare the field yourself. Your declaration replaces the default for that field only:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({ agent: true })],
  env: {
    server: {
      telegram: {
        botToken: env({ secret: true, source: env.source('TELEGRAM_TOKEN') }),
      },
    },
  },
})
```

Discovery reads the Agent definition files. It finds factory calls imported from `vite-hub/agent/channels` or `@vite-hub/agent/channels`, such as `telegram()` or `channels.telegram()`, and shorthands in the `channels` option of `defineAgent()`, such as `channels: { telegram: { ... } }`. The option and each Channel value can be an object literal or a module-level `const` object. A bare factory such as `channels: { support: telegram }` counts as that factory without options. Discovery does not follow a Channel created in another module. In that case, declare the fields yourself. When the Channel options are not an object literal, the fields are declared as optional.

When Server Env declares a field, the Channel reads only Server Env, including provider-backed values. A missing required value fails with `ENV_REQUIRED_MISSING` instead of using the default host variable. A Channel reads the host variable names directly only for a field that Server Env does not declare, for example without `vitehub()`. GitHub follows the same rules.

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

Adapter-backed Channels accept messages without a mention only in a direct conversation with the Agent. Group conversations, channels, and shared chats between people require an explicit Agent mention on every message. A previous mention or thread subscription does not grant permission to answer later unmentioned messages. The same rule applies to queued messages and steering an active invocation.

Use `messages.filter` to add application-specific restrictions before an invocation starts. Returning `false` posts no loading message or fallback error because the Agent never started. Accepted deliveries have `deliveryKind: 'direct'` or `deliveryKind: 'mention'`.

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

ViteHub posts the Agent's final text by default. An `agent:finish` hook may add more replies with `event.reply()`. After successful final delivery, ViteHub skips a non-streaming, text-only hook reply whose trimmed text is the same as the final text. Streamed hook replies and replies with artifacts, attachments, or files still post. ViteHub does not buffer a hook reply stream to compare its text. If automatic final delivery fails, the hook reply remains available as a fallback. Use `messages.delivery: 'manual'` when finish hooks own all replies; ViteHub then posts no final text.

With `messages.loading` or manual delivery, a generated Workflow may carry the reply across a durable boundary when the Channel and host support it. An explicit `messages.timeout` bounds inline execution and the durable handoff's typing indicator, but it does not cap the durable Agent Workflow. `steer` queues overlapping messages and preserves that Workflow handoff. Other overlap policies such as `serial`, `drop`, `queue`, and `reject` remain inline and cannot be combined with required durable delivery.

For a progress message that is edited while the Agent works, configure `messages.loading`. Its required `text` accepts a string, rotating string array, callback, or `null`; `intervalMs` controls the minimum update interval. Set `updates: 'commentary'` to project explicit commentary text into that message. The loading message holds the reply until the Agent finishes, so it cannot be combined with `messages.stream` or `messages.commentary`. Then ViteHub replaces the loading message with the final text: it deletes the loading message and posts the reply, or edits the loading message when it cannot delete it. Set `messages.final.delivery: 'new-message'` to post the final text first and then remove the loading message. Finish hook replies follow the final text. With `messages.delivery: 'manual'`, the first hook reply takes the place of the loading message.

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

To send an application message without an Agent, use the [Channels Server Primitive](/docs/server-primitives/channels).
