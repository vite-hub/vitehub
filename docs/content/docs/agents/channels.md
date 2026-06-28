---
title: Channels
description: Keep message origins, delivery facts, Agent Actors, and input commands separate.
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
    github: github({ events: { pullRequestComments: true } }),
    portal: stream({ route: true }),
    web: webChat(),
  },
  run: () => 'ok',
})
```

Built-in helpers include `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, `stream()`, and `webChat()`. Use `defineChannel(kind, options)` for an app-owned Channel Kind.

## Boundary map

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Channel | Origin, event, delivery, thread, and message metadata. | Trusted identity, access decisions, command rewriting. |
| Agent Actor | Trusted caller identity for one Agent Invocation. | Transport delivery, webhook shape, UI session state. |
| Input Command | User-authored command parsing and input rewriting before the Agent Driver runs. | Channel verification, delivery, caller identity. |

This split keeps shared channels from becoming implicit access roles. A Teams channel, GitHub comment, or app chat thread can reach an Agent without proving who the trusted caller is.

## Message-shaped input

Chat and channel surfaces usually start Agents with `messages`. The Chat Capability registers the `chat.message` Agent Trigger and translates UI-message-like input into Agent messages.

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

Delivery effects can include artifacts that were written into the Agent Workspace. Use `publishWorkspaceArtifacts()` from `@vite-hub/agent/channels` inside a finish effect when a channel needs public URLs or channel-native attachment handles.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { github, publishWorkspaceArtifacts } from '@vite-hub/agent/channels'
import { blob } from '@vite-hub/blob'

export default defineAgent({
  channels: {
    github: github({
      app: true,
      events: {
        pullRequestComments: {
          reply: async (event, context) => ({
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
            kind: 'review',
            payload: { body: String(event.result || '').trim() || '_No review generated._' },
          }),
        },
      },
    }),
  },
  run: () => 'ok',
})
```

The GitHub channel renders inline image artifacts as markdown in `reply` and `review` effects. It only renders artifacts that already have a `url`; it does not scan `screenshots/**` or upload files unless your finish effect explicitly asks it to.

## Next steps

- Read [Triggers](/docs/agents/triggers) for `chat.message` and app-owned trigger consumers.
- Read [Invokers](/docs/agents/invokers) for trusted identity compatibility APIs.
- Read [Chat History and sessions](/docs/agents/chat-history-sessions) for conversation boundaries.
