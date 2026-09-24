# @vite-hub/channels

`useChannel(name)` sends through a global Channel declared on an Agent Definition. Applications using `vite-hub` normally import `useChannel` from `vite-hub/channels/server`.

```ts
import { defineAgent } from 'vite-hub/agent'
import { teams } from 'vite-hub/agent/channels'
import { useChannel } from 'vite-hub/channels/server'

const bot = defineAgent({
  driver: { run: () => 'Ready' },
  channels: {
    teams: teams({ global: true, credentials: () => ({ appId, appPassword, tenantId }) }),
  },
})

await useChannel('teams').send('Build finished.', 'user:entra-user-id')
```

The Agent's channel configuration is the source of truth. ViteHub discovers it through the Agent Definition, so applications do not create `server/channels` files or enable a separate integration. The Teams sender accepts `user:<id>` for a private conversation or an encoded Teams thread ID for an existing conversation.

The package also exports `createChannel()` and `defineChannel()` for explicit library composition. `useChannel()` resolves only Agent Channels marked `global: true`.

`send()` waits for the provider and returns a normalized delivery result. It logs attempt metadata without message text. It does not persist, retry, or deduplicate sends.
