---

title: Send through your first Channel
description: Define a named Channel, send a local build notification from server code, and inspect the connector receipt.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You send a "Build finished." message through a Channel with the name `alerts`. A Channel is a named place that your server code sends messages to. In this tutorial, the Channel prints the message in your terminal, so you can test the code before you connect Slack, email, or another service.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.

You do not need an account or an API key. No message leaves your computer.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3 vite
```

`vite-hub` gives you Channels. `nitro` and `h3` serve the API route.

Turn on Channels in `vite.config.ts`. Keep the other plugins of your app.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true })],
})
```

`preset: 'node'` tells ViteHub that the app runs on a Node.js server. `channels: true` makes ViteHub find your Channel files. It looks in two places:

- files in `server/channels/`
- files with a name that ends in `.channel.ts`

A folder with an `index` file, such as `server/channels/teams/index.ts`, is one Channel. The folder name is the Channel name. The other files in that folder are helpers that the Channel imports.

> [!NOTE]
> ViteHub reads each file without running it. It skips a file that cannot be a Channel that sends messages: a default export that is a function, a class, a primitive value, an array, a call to the Agent `defineChannel()`, or an object without `connectors`, and a file with neither a default export nor a `connectors` export. Agent Channels, which receive messages, can live in `server/channels/` too. An Agent `defineChannel()` with a `webhooks.path` [serves its own webhook route](/docs/agents/channels#give-a-channel-its-own-route).

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts`. A connector is one way to deliver a message, for example Slack or email. This Channel has one connector, `log`, that prints the message and returns a receipt. A receipt is the proof of delivery that the connector gives back.

```ts [server/channels/alerts.ts]
import { defineOutboundChannel } from 'vite-hub/channels'
export default defineOutboundChannel({
  connectors: {
    log: {
      send(text: string, { label }: { label: string }) {
        console.log(`[${label}] ${text}`)
        return { id: `log-${label}` }
      },
    },
  },
})
```

The file name `alerts` is the Channel name. The file `src/alerts.channel.ts` gives the same `alerts` Channel.

::

::tutorial-step{title="Send and verify one delivery"}
## Send and verify one delivery

Create an API route that sends the message:

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', {
    connector: 'log',
    label: 'release',
  })
  if (error) throw error
  return receipt
})
```

- `useChannel('alerts')` picks the `alerts` Channel.
- `connector: 'log'` picks the connector. Its `send()` function gets the text and the `label`.
- `send()` returns `[error, receipt]`. If `error` is set, the route throws it. If not, the route returns the receipt.

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/build-finished
```

You see:

```json [output/response.json]
{
  "channel": "alerts",
  "connector": "log",
  "deliveryId": "...",
  "id": "log-release"
}
```

`deliveryId` is a new id for each send. `id` comes from your connector. The terminal that runs Vite also prints `[release] Build finished.`. The terminal line proves that the connector ran. The response proves that your route got the receipt back.

> [!NOTE]
> Channels does not include connectors for Slack or other services, and it does not try a failed send again. In a real connector, read the API key inside `send()` with [Env](/docs/env), which keeps server secrets on the server. Never put the key in browser code.

::

## Next steps

- [Send from an H3 or Nitro handler](/docs/channels/server-api#send-from-an-h3-or-nitro-handler): send messages from your own routes.
- [Add another connector](/docs/channels/server-api#add-another-connector): send the same Channel to a second service.
- [Agent capability](/docs/channels/agent-capability): let an Agent send messages through a Channel.
