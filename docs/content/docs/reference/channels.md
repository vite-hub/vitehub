---
title: Channels
description: Send through a Channel configured on an Agent Definition.
navigation.order: 54.5
navigation.group: Application APIs
icon: i-lucide-radio-tower
---

An Agent Channel owns the connection to a messaging service. Set `global: true` to let other server code send through that same Channel with `useChannel(name)`. ViteHub discovers the Channel through the Agent Definition. No `server/channels` file or separate `channels` Vite option is needed.

## Configure Teams once

```ts [server/agents/bot/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { teams } from 'vite-hub/agent/channels'
import { useServerEnv } from '#vitehub/env/server'

export default defineAgent({
  driver: { run: () => 'Ready' },
  channels: {
    teams: teams({
      global: true,
      route: true,
      credentials: () => ({
        appId: useServerEnv().teams.appId,
        appPassword: useServerEnv().teams.appPassword.unseal(),
        tenantId: useServerEnv().teams.tenantId,
      }),
    }),
  },
})
```

The Teams Channel uses these credentials for its inbound adapter and outbound sender. Keep credentials in Server Env. A global Teams Channel requires `credentials` or a custom `send` function.

## Send from server code

```ts [server/api/notify.post.ts]
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  return await useChannel('teams').send('Build finished.', 'user:entra-user-id')
})
```

`send(message, target)` sends immediately and returns a result with the Channel name, connector name, delivery ID, and optional provider message ID. For Teams, `user:<id>` starts a private conversation with an Entra user. Pass an encoded Teams thread ID to post in an existing conversation. The target belongs in trusted server code when an Agent capability exposes a send tool.

An Agent that extends another Agent can use the inherited Channel. If both definitions expose the same Channel object, ViteHub registers it once. Two distinct Channels cannot claim the same global name; `useChannel()` rejects that ambiguous configuration.

The sender emits metadata-only `vitehub.channel.send` events for started, completed, and failed attempts. It does not persist, retry, or deduplicate outbound sends. Ordinary Agent replies still use the invocation's originating Channel.
