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

Set `messages.filter` on an adapter-backed Channel to admit only supported incoming messages before Agent invocation. The filter receives the normalized current `Message`, its `deliveryKind`, the Channel callback context, run metadata, and thread controls; returning `false` ignores the delivery without starting the Agent or posting an error fallback. `deliveryKind` is `direct`, `mention`, or `subscribed`; explicit mentions remain `mention` in threads the Agent already subscribes to.

```ts
teams({
  adapter,
  messages: {
    filter: ({ deliveryKind }) =>
      deliveryKind === 'direct' || deliveryKind === 'mention',
  },
})
```

## Deliver public commentary

Adapter-backed Channels hide commentary by default. Set `messages.commentary` to `message` when an explicitly phased Agent stream should publish commentary as one best-effort progress message and deliver the final response as a separate message.

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
      messages: { commentary: 'message' },
    }),
  },
  driver: createAgentDriver(),
})
```

ViteHub publishes only text that the Agent stream explicitly marks as `commentary`. It never treats reasoning, unphased text, tool position, timing, or prose as public commentary. The adapter can update one progress message, use native activity, or omit progress when the platform cannot render it; a progress delivery failure does not block the final response.

Set `commentary: 'hidden'` to keep the same phase separation without publishing progress. The existing explicit `messages.stream: true` option retains its publish-all-text behavior for integrations that intentionally depend on unphased streaming.

::note
The built-in Codex and Claude Code Harness V1 bridges do not currently preserve commentary and final phases. The `message` policy produces public progress only for custom or future Agent Drivers that emit those phases explicitly.
::

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

The `run` fields are Agent Run metadata. They help CLI output, traces, and finish hooks explain where the invocation came from.

Message-shaped Channels also record a canonical `channel` Agent Invocation Context Value. Capability callbacks, dynamic model metadata callbacks, and Source resolvers receive it directly as `context.channel`; instruction composition can read it as `context.channel`. It contains the current `message`, `meta`, `run`, `session`, and `user` values when available.

Augment `ViteHubAgentChannelMeta` and `ViteHubAgentChannelUser` in application code to type app-owned metadata and user fields.

### Receive attachments as references

Adapter-backed Channels preserve incoming images, audio, and generic files as typed Agent Message parts by default. No Capability or Channel option enables this. Each part keeps every handle supplied by the adapter: inline `data`, lazy `fetchData`, adapter-owned `fetchMetadata`, `url`, `mediaType`, `name`, and `size`.

Normalization does not call `fetchData`, fetch a generic attachment URL, write a local file, or persist a blob. A Capability or Agent Driver chooses how to consume the reference. This keeps authenticated and expiring provider access inside the adapter while letting a consumer pass an HTTPS URL, resolve bytes, or explicitly persist the attachment only when needed.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run({ messages }) {
      const attachments = messages.flatMap(message =>
        message.parts.filter(part =>
          part.type === 'image' || part.type === 'audio' || part.type === 'file',
        ),
      )

      return `Received ${attachments.length} attachment references.`
    },
  },
})
```

Model-backed Agents pass inline data and HTTPS references as typed model input. For the current Channel turn, the model driver prefers an attachment's adapter-owned `fetchData` callback immediately before invocation. Channel history callbacks are not replayed; history retains only serializable data and URL references. The driver resolves attachments sequentially and checks both the declared and resolved byte size against one invocation-wide budget. The default limit is 25 MiB; change the real resource policy with `driver.execution.attachments.maxBytes`.

```ts [server/agents/vision.ts]
export default defineAgent({
  driver: {
    model,
    execution: {
      attachments: { maxBytes: 10 * 1024 * 1024 },
    },
  },
})
```

Only HTTPS attachment URLs are forwarded as remote model input. ViteHub does not download arbitrary URLs on the server, because that would create an SSRF surface. Forwarding a signed URL also discloses its temporary access to the model provider, and provider URLs may expire; use `fetchData` for authenticated or refreshable access and treat durable persistence as a separate application decision.

The byte limit checks a declared `size` before resolving provider data, then checks the resolved value using UTF-8 bytes for strings, `byteLength` for buffers and typed-array views, and `size` for Blobs. Invalid and non-HTTPS URLs are omitted from model input.

Harness-backed Agents retain URL-bearing parts in their input, but callbacks and binary objects cannot cross a serialized harness boundary. A private callback-only attachment needs a Capability that consumes it or an explicit future asset/persistence contract; ViteHub does not materialize it in `/tmp`. `serializeMessages()` rejects unresolved attachment callbacks and non-string binary data. The pure synchronous `toAiSdkModelMessages()` converter rejects callback- and Blob-only inputs; use the model-backed Agent Driver for its asynchronous invocation-time conversion, or provide an HTTPS URL.

Text-like files keep the existing bounded prompt behavior: ViteHub decodes recognized text attachments up to 8 MiB and emits a text part instead of a duplicate file part. Other attachment normalization is inert.

## Admit web chat requests

Use `webChat()` when an Agent should admit requests from the generated AI SDK UI-message dispatcher. Publish that dispatcher with `routes.chat: true` on `hubAgent()`, or set `routes.chat` to a custom route string. Pass Channel `route` options when requests need authentication or product context, or set `route: false` when application code invokes the Channel from its own handler.

Omitting `routes.chat` keeps the public dispatcher absent even when an Agent declares `webChat()`. Enabling the dispatcher does not expose every Agent: only Agents with a route-enabled `webChat()` Channel answer it.

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
                const [error, object] = await blob.put(pathname, content, { access: 'public', contentType: mediaType })
                if (error) throw error
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

GitHub Pull Request Context enrichment is bounded before it reaches the Agent Invocation Context. By default, `github({ pullRequest: true })` records up to 30 comments, 200 changed files, 12,000 pull request body characters, and 2,000 characters per comment body. Override those with `maxComments`, `maxFiles`, `maxBodyLength`, and `maxCommentBodyLength` on the `pullRequest` option. Rendered comments are labeled as untrusted user content, and failed metadata enrichment is recorded at `pullRequest.metadata.unavailable`.

## Next steps

- Read [Triggers](/docs/agents/triggers) for `chat.message` and app-owned trigger consumers.
- Read [Agent Actors](/docs/agents/actors) for trusted caller identity and the exact `invoker` API fields.
- Read [Chat History and sessions](/docs/agents/chat-history-sessions) for conversation boundaries.
