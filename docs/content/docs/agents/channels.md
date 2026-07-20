---
title: Channels
description: Keep invocation origins, delivery facts, Agent Actors, and input commands separate.
navigation.order: 25
icon: i-lucide-radio
---

A Channel names where an Agent Invocation came from and how message-shaped events move through the system. Channels carry origin, event, delivery, thread, and message facts; they do not carry trusted caller identity by themselves.

Use Channels for reachability and delivery. Use Agent Actors for identity, and use input commands for explicit user-authored command handling.

Channel Kind helpers are imported from `@vite-hub/agent/channels`, not the root `@vite-hub/agent` entry.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { github, webChat } from '@vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({ pullRequest: true }),
    portal: webChat,
  },
  driver: { run: () => 'ok' },
})
```

Built-in helpers include `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()`. A synchronous Channel factory that needs no options can be registered directly, so `channels: { portal: webChat }` is equivalent to `channels: { portal: webChat() }` and resolves once when `defineAgent()` runs. Call the helper when passing options, such as `webChat({ messages: { sessions: false } })`. Use `defineChannel(kind, options)` for an app-owned Channel Kind.

Adapter-backed Channels deliver only the completed response by default. Set top-level `defineAgent({ messages: { stream: true } })` to opt every adapter Channel into draft and edit updates, or set `messages.stream` on an individual Channel to control progressive delivery for that destination. Web Chat routes return streaming HTTP responses independently of adapter delivery settings.

## Scope capabilities to a Channel

Put a Capability on a Channel when only invocations from that Channel should receive the ability. Agent-level Capabilities remain active for every invocation; ViteHub appends the active Channel's Capabilities when `run.channelId` or the Agent Trigger identifies that Channel.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { openapi } from '@vite-hub/agent/capabilities'
import { teams, webChat } from '@vite-hub/agent/channels'

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

Direct invocations without an active Channel receive only the Agent-level Capabilities. Channel Trigger callbacks can inspect their effective list through `context.agentCapabilities`. Keep authentication and Agent Actor resolution at the route, trigger, or `access()` boundary; Channel-scoped Capabilities select abilities, not trusted identity.

## Discord

Use `discord({ adapter })` when a Discord bot should receive message events through Chat SDK's Discord adapter. Install `@chat-adapter/discord` in the app when using the built-in adapter options. ViteHub keeps Discord conversation state thread-scoped by default, so separate Discord threads can run independent Agent conversations.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { discord } from '@vite-hub/agent/channels'

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
  driver: { run: () => 'ok' },
})
```

Set `routes.discordGateway: true` on `hubAgent()` when the deployment needs a generated Nitro route that wakes the Discord Gateway listener and forwards events into the Agent webhook route. The default route is `/api/_vitehub/agents/[agent]/discord/gateway`; set the required production `VITEHUB_DISCORD_GATEWAY_SECRET` bearer token, `VITEHUB_DISCORD_GATEWAY_DURATION_MS` to tune listener duration, or `VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL` when the generated webhook URL is not externally reachable.

## Boundary map

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Channel | Origin, event, delivery, thread, message metadata, and origin-scoped abilities. | Trusted identity, access decisions, command rewriting. |
| Agent Actor | Trusted caller identity for one Agent Invocation. | Transport delivery, webhook shape, UI session state. |
| Input Command | User-authored command parsing and input rewriting before the Agent Driver runs. | Channel verification, delivery, caller identity. |

This split keeps shared channels from becoming implicit access roles. A Teams channel, GitHub comment, or app chat thread can reach an Agent without proving who the trusted caller is.

## Message-shaped input

Message-shaped Channels usually start Agents with `messages`. The `chat.message` Agent Trigger maps UI-message-like input into Agent messages; chat history and sessions stay in message Channel settings rather than route admission.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string, threadId?: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    run: {
      channelId: 'portal-support',
      messageId: runId,
      origin: 'portal',
      runId,
      threadId: body.threadId,
    },
  })
})
```

The `run` fields are Agent Run metadata. They help DevTools, traces, and finish hooks explain where the invocation came from.

Message-shaped Channels also record a canonical `channel` Agent Invocation Context Value. Capability callbacks, dynamic model metadata callbacks, and Source resolvers receive it directly as `context.channel`; instruction composition can read it as `context.channel`. It contains the current `message`, `meta`, `run`, `session`, and `user` values when available.

Augment `ViteHubAgentChannelMeta` and `ViteHubAgentChannelUser` in application code to type app-owned metadata and user fields.

## Admit web chat requests

Use `webChat()` when a web destination should expose the generated AI SDK UI-message route. Pass `route` options when the route needs authentication or product context, or set `route: false` when application code invokes the Channel from its own handler.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { webChat } from '@vite-hub/agent/channels'

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
        input: {
          trust: ['meta', 'user', 'session', 'timeout'],
        },
      },
    }),
  },
  driver: { run: () => 'ok' },
})
```

ViteHub reads the raw request body once, parses the JSON object, runs `authenticate` with `rawBody`, then validates `admission.body` when a Standard Schema is provided. `input.trust` lists request body fields that may be copied after authentication. Add `timeout` only when authenticated callers may control Agent Invocation duration; ViteHub forwards positive, finite numeric values and ignores invalid timeouts. Use `admission.context` only when the route needs to derive or validate different `chat.message` input.

## Add identity separately

When the channel handler authenticates a user, pass that identity as the Agent Actor. The trusted invocation input key is `invoker`; Agent and Capability callbacks receive the resolved Actor as both `actor` and `invoker`.

```ts [server/api/support-chat.post.ts]
return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
  messages,
  invoker: {
    id: user.id,
    kind: 'customer',
    label: user.email,
    meta: { customer: user.customer },
  },
  run,
})
```

Validate the channel request before passing the Agent Actor. ViteHub trusts actor values supplied by server-owned Agent Trigger Consumers.

## Keep commands in Capabilities

Input Commands are Capability behavior. A channel can deliver `/summary`, but `inputCommands()` should own command admission, rewriting, and command-specific trust.

Link command docs and command examples to [Capabilities](/docs/capabilities), not to channel configuration.

## Deliver Workspace artifacts

Delivery effects can include artifacts that were written into the Agent Workspace. Use workspace-relative artifact paths so ViteHub can read the generated files through the Agent Workspace instead of exposing host filesystem paths.

Adapter-backed message channels, such as Slack, Telegram, Teams, Discord, and custom `defineChannel()` integrations with an adapter, send delivery artifacts through Chat SDK message output. Artifacts with a `url` become Chat SDK attachments. Workspace artifacts without a `url` become uploaded files when the artifact is not marked with `placement: 'link'`.

```ts [server/agents/support.ts]
import { defineAgent, defineCapability } from '@vite-hub/agent'
import { defineFinishEffect, telegram } from '@vite-hub/agent/channels'

const screenshotDelivery = defineCapability({
  id: 'screenshot-delivery',
  prepare(context) {
    context.delivery.finishEffect(defineFinishEffect(context => context.reply({
      body: 'See attached screenshot.',
      artifacts: [{
        mediaType: 'image/png',
        path: 'screenshots/login.png',
        placement: 'attachment',
      }],
    })))
  },
})

export default defineAgent({
  capabilities: [screenshotDelivery],
  channels: {
    support: telegram({ adapter: createTelegramAdapter }),
  },
  workspace: { mode: 'write' },
  driver: {
    run: async ({ workspace }) => {
      await renderScreenshot(workspace, 'screenshots/login.png')
      return 'Captured the login state.'
    },
  },
})
```

GitHub comments and reviews need hosted markdown URLs instead of channel-native file uploads. Harness Agents can use the Blob Capability's `assetPaths` option: ViteHub publishes current-run files referenced in the final Markdown and carries them through custom `context.reply()` finish effects automatically. The GitHub channel rewrites those exact paths to their published URLs.

Use `publishWorkspaceArtifacts()` from `@vite-hub/agent/channels` when a custom-run or app-owned finish effect needs to publish an explicit artifact list itself.

Finish effects receive a delivery context with `context.output`, normalized `context.result`, `context.text`, `context.workspace`, `context.run`, and `context.context` so app-side delivery code can read final output, Workspace files, and typed Agent Invocation Context values without re-parsing the stream.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { defineFinishEffect, github, publishWorkspaceArtifacts } from '@vite-hub/agent/channels'
import { blob } from '@vite-hub/blob'

export default defineAgent({
  channels: {
    github: github({
      app: true,
      pullRequest: {
        reply: defineFinishEffect(async (context) => {
          if (context.error) return context.reply(`Review failed: ${context.errorMessage}`)
          const body = context.text?.trim() || '_No review generated._'
          return {
            kind: 'review',
            payload: { body },
            artifacts: await publishWorkspaceArtifacts(context, [{
              alt: 'Login footer version badge',
              mediaType: 'image/png',
              path: 'screenshots/login-version-badge-desktop.png',
              placement: 'inline',
            }], {
              prefix: `reviews/${context.run?.runId || crypto.randomUUID()}`,
              publish: async ({ content, mediaType, pathname }) => {
                const object = await blob.put(pathname, content, { access: 'public', contentType: mediaType })
                return { url: object.url }
              },
            }),
          }
        }),
      },
    }),
  },
  driver: { run: () => 'ok' },
})
```

The GitHub channel renders inline image artifacts as markdown in `reply` and `review` effects. It does not attach local files directly to GitHub comments.

## Trigger an Agent from a pull request label

Use the GitHub Channel's `pull_request.labeled` trigger when a GitHub App should start an Agent without polling or a scheduler. The Channel verifies the webhook and admits the configured label and sender before the Agent Driver runs. Capabilities and finish hooks can move application-owned lifecycle labels through generic delivery effects.

```ts [server/agents/maintainer.ts]
import { defineAgent, defineCapability } from '@vite-hub/agent'
import { github } from '@vite-hub/agent/channels'

const lifecycle = defineCapability({
  id: 'pull-request-lifecycle',
  prepare(context) {
    context.delivery.effect({
      kind: 'labels',
      payload: { action: 'add', labels: ['agent:working'] },
    })
    context.delivery.effect({
      kind: 'labels',
      payload: { action: 'remove', labels: ['agent:ready'] },
    })
  },
})

export default defineAgent({
  capabilities: [lifecycle],
  channels: {
    github: github({
      app: true,
      pullRequest: {
        labeled: {
          label: 'agent:ready',
          allowedSenders: [{ id: 583231, login: 'octocat' }],
        },
      },
    }),
  },
  driver: { run: () => 'Maintained the pull request.' },
  runtime: false,
  hooks: {
    'agent:finish'(event) {
      return [{
        kind: 'labels',
        payload: {
          action: 'add',
          labels: [event.error ? 'agent:blocked' : 'agent:done'],
        },
      }, {
        kind: 'labels',
        payload: { action: 'remove', labels: ['agent:working'] },
      }]
    },
  },
})
```

The lifecycle names belong to the application. Use `add` or `remove` to preserve unrelated labels. `replace` sends the complete desired label set, including an empty array when the pull request should have no labels. Each action is a separate, best-effort delivery effect: a failure is recorded in the `channel:delivery-effect` trace and does not fail the Agent Invocation, so a multi-action transition can be only partly applied. The channel always applies effects to the pull request and App installation admitted by the current invocation; effect payloads and metadata cannot redirect them.

GitHub Pull Request Context enrichment is bounded before it reaches the Agent Invocation Context. By default, `github({ pullRequest: true })` records up to 30 comments, 200 changed files, 12,000 pull request body characters, and 2,000 characters per comment body. Override those with `maxComments`, `maxFiles`, `maxBodyLength`, and `maxCommentBodyLength` on the `pullRequest` option. Rendered comments are labeled as untrusted user content, and failed metadata enrichment is recorded at `pullRequest.metadata.unavailable`.

GitHub calls the account that caused a webhook the `sender`. `allowedSenders` uses its stable numeric account ID on the configured GitHub host. An optional `login` is a readable, case-insensitive assertion; a mismatch is rejected. Admitted invocations include the repository id and full name, pull request number, exact base and head refs and SHAs, source repo and immutable head SHA, label, sender, installation id, and GitHub delivery id in the typed Pull Request Context.

Configure an [Agent State Provider](/docs/agents/chat-history-sessions#persist-state-deliberately) for durable delivery claims and exact-head leases, and keep execution inline with `runtime: false` so ownership and the Agent run share one execution boundary. One delivery id starts only one run. After ownership is released, removing and reapplying the label creates a new delivery that can rerun the same head; simultaneous deliveries for the same repository, pull request, and head SHA are rejected. The dev trigger also accepts a raw GitHub `pull_request` payload for local fixture replay and derives a deterministic development delivery ID from it.

The GitHub App must subscribe to pull request events and grant either `Pull requests: write`, or `Pull requests: read` together with `Issues: write`. With `app: true`, configure `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and either `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`. The webhook secret verifies deliveries; the installation id selects the App installation whose short-lived token changes labels. Keep the private key and installation tokens in the Channel runtime; ViteHub does not pass them into an Agent Box.

## Next steps

- Read [Triggers](/docs/agents/triggers) for `chat.message` and app-owned trigger consumers.
- Read [Agent Actors](/docs/agents/actors) for trusted caller identity and the exact `invoker` API fields.
- Read [Chat History and sessions](/docs/agents/chat-history-sessions) for conversation boundaries.
