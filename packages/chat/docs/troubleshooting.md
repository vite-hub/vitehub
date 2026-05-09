---
title: Chat troubleshooting
description: Fix missing names, platform routes, duplicate hooks, Agent binding, and state issues.
navigation.title: Troubleshooting
navigation.order: 4
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when a webhook or chat definition fails.

## Missing user name

Error:

```txt
Missing chat userName
```

Cause: the chat cannot infer a name.

Fix: set `userName`, or use a discovered file name such as `server/chat.ts`.

```ts
export default defineChat({
  adapters,
  state,
  userName: 'Support Bot',
})
```

## Unknown platform

Cause: the webhook route includes a platform that is not present in `adapters`.

Fix: make the adapter key match the route param.

```ts
export default defineChat({
  adapters: {
    telegram: createTelegramAdapter(config),
  },
  state,
  userName: 'Support Bot',
})
```

The default route for this adapter is:

```txt
/api/webhooks/telegram
```

## Duplicate hook

Error:

```txt
Duplicate chat hook "onDirectMessage"
```

Cause: the same hook exists at the top level and inside `hooks`, or `agent` is used with `onDirectMessage`.

Fix: choose one owner for the direct-message flow.

## Agent binding does not run

Check these conditions:

- `@vitehub/agent` is registered.
- The agent file is under `server/agents/**` or exported from `server/agents.ts`.
- The chat definition uses `agent: 'agentName'`.
- The chat does not also define `onDirectMessage`.

## Durable Object state is missing

Cause: Cloudflare Durable Object state is configured in the chat definition but not in module config.

Fix: enable it in both places.

```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
  chat: {
    provider: 'cloudflare',
    cloudflare: {
      durableObjectState: true,
    },
  },
})
```

```ts [server/chat.ts]
import { cloudflareDurableObjectState } from '@vitehub/chat/cloudflare'

export default defineChat({
  adapters,
  state: cloudflareDurableObjectState(),
  userName: 'Support Bot',
})
```
