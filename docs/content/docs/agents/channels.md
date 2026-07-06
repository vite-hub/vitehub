---
title: Channels
description: Keep invocation origins, delivery facts, Agent Actors, and input commands separate.
navigation.order: 25
icon: i-lucide-radio
---

A Channel names where an Agent Invocation came from and how message-shaped events move through the system. Channels carry origin, event, delivery, thread, and message facts; they do not carry trusted caller identity by themselves.

Use Channels for reachability and delivery. Use Agent Actors for identity, and use input commands for explicit user-authored command handling. The current API still exposes Agent Actor values through `context.invoker` and `defineAgent({ invoker })` while the public language migrates.

Channel Kind helpers are imported from `@vite-hub/agent/channels`, not the root `@vite-hub/agent` entry.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { github, stream, webChat } from '@vite-hub/agent/channels'

export default defineAgent({
  channels: {
    github: github({ pullRequest: true }),
    portal: stream({ route: true }),
    web: webChat(),
  },
  run: () => 'ok',
})
```

Built-in helpers include `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, `stream()`, and `webChat()`. Use `defineChannel(kind, options)` for an app-owned Channel Kind.

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
  run: () => 'ok',
})
```

Set `routes.discordGateway: true` on `hubAgent()` when the deployment needs a generated Nitro route that wakes the Discord Gateway listener and forwards events into the Agent webhook route. The default route is `/api/_vitehub/agents/[agent]/discord/gateway`; set the required production `VITEHUB_DISCORD_GATEWAY_SECRET` bearer token, `VITEHUB_DISCORD_GATEWAY_DURATION_MS` to tune listener duration, or `VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL` when the generated webhook URL is not externally reachable.

## Boundary map

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Channel | Origin, event, delivery, thread, and message metadata. | Trusted identity, access decisions, command rewriting. |
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

The `run` fields are first-class Agent Run metadata, not Chat context. They help DevTools, traces, and finish hooks explain where the invocation came from.

## Admit web chat requests

Use `webChat({ route })` when an app-owned web chat route needs the common AI SDK UI-message request shape but still owns authentication and product context.

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
          trust: ['meta', 'user', 'session'],
        },
      },
    }),
  },
  run: () => 'ok',
})
```

ViteHub reads the raw request body once, parses the JSON object, runs `authenticate` with `rawBody`, then validates `admission.body` when a Standard Schema is provided. `input.trust` lists request body fields that may be copied after authentication. Use `admission.context` only when the route needs to derive or validate different `chat.message` input.

## Add identity separately

When the channel handler authenticates a user, pass that identity as the Agent Actor. The current runtime input field is still named `invoker`, so Agents and Capabilities read `context.invoker` until the compatibility API is replaced.

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
import { defineFinishEffect, reply, telegram } from '@vite-hub/agent/channels'

const screenshotDelivery = defineCapability({
  id: 'screenshot-delivery',
  prepare(context) {
    context.delivery.finishEffect(defineFinishEffect(() => reply({
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
  run: async ({ workspace }) => {
    await renderScreenshot(workspace, 'screenshots/login.png')
    return 'Captured the login state.'
  },
})
```

GitHub comments and reviews need hosted markdown URLs instead of channel-native file uploads. The GitHub channel publishes workspace image paths that appear in reply or review bodies, then rewrites those paths to hosted raw URLs. Use `publishWorkspaceArtifacts()` from `@vite-hub/agent/channels` inside a finish effect when explicit GitHub artifacts need public URLs before delivery.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { defineFinishEffect, github, publishWorkspaceArtifacts, reply } from '@vite-hub/agent/channels'
import { blob } from '@vite-hub/blob'

export default defineAgent({
  channels: {
    github: github({
      app: true,
      pullRequest: {
        reply: defineFinishEffect(async (event, context) => {
          if (event.error) return reply(`Review failed: ${event.errorMessage}`)
          const body = event.text?.trim() || '_No review generated._'
          return reply({
            body,
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
          }),
        }),
      },
    }),
  },
  run: () => 'ok',
})
```

The GitHub channel renders inline image artifacts as markdown in `reply` and `review` effects. It does not attach local files directly to GitHub comments.

GitHub Pull Request Context enrichment is bounded before it reaches the Agent Invocation Context. By default, `github({ pullRequest: true })` records up to 30 comments, 200 changed files, 12,000 pull request body characters, and 2,000 characters per comment body. Override those with `maxComments`, `maxFiles`, `maxBodyLength`, and `maxCommentBodyLength` on the `pullRequest` option. Rendered comments are labeled as untrusted user content, and failed metadata enrichment is recorded at `pullRequest.metadata.unavailable`.

## Next steps

- Read [Triggers](/docs/agents/triggers) for `chat.message` and app-owned trigger consumers.
- Read [Invokers](/docs/agents/invokers) for trusted identity compatibility APIs.
- Read [Chat History and sessions](/docs/agents/chat-history-sessions) for conversation boundaries.
