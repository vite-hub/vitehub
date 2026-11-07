---

title: Send through your first Channel
description: Define a named Channel, send a local build notification from server code, and inspect the connector receipt.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Channel is a named place that your server sends messages to, such as a Slack room or a Telegram chat. Your code sends to the name. A connector of the Channel delivers the message.

In this tutorial, you make a Channel named `alerts` and send a "Build finished." message through it. The message goes to your terminal, not to a real service, so you can test your code first.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer, pnpm, and a Vite app. Run the commands from the root of the app. You need no account and no API key. No message leaves your computer.

::tutorial-step{title="Install and enable discovery"}
## Install and enable discovery

Install ViteHub. Nitro is the server that runs your API routes.

```bash pm [commands/install]
pnpm add vite-hub nitro h3 vite
```

Then add `channels: true` to `vitehub()` in `vite.config.ts`. Keep the other plugins of your app.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true })],
})
```

ViteHub now finds each Channel file in `server/channels`.

:::details{summary="How ViteHub finds Channel files"}
ViteHub discovers files below `server/channels` and files that end in `.channel.ts`. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder. Other files in that folder are helpers that the Channel imports. Discovery reads each module without running it and skips modules that cannot be outbound Channels: a default export that is a function, a class, a primitive value, an array, a call to the Agent `defineChannel()`, or a statically known object literal without `connectors`, and modules with neither a default nor a `connectors` export. Agent Channels can live in `server/channels` next to outbound Channels. An Agent `defineChannel()` with a `webhooks.path` there [serves its own webhook route](/docs/agents/channels#give-a-channel-its-own-route).
:::

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts`. The file name is the name of the Channel: `alerts`.

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

- A connector is one way to deliver a message. This Channel has one connector, `log`.
- `send()` gets the text and your options. Here it writes the text to the terminal.
- `send()` returns a receipt with an `id`. A real connector returns the message id from the service.

You can also name the file `src/alerts.channel.ts`. ViteHub finds the same `alerts` Channel.

::

::tutorial-step{title="Send and verify one delivery"}
## Send and verify one delivery

Create an API route that sends a message to `alerts`.

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

- `useChannel('alerts')` picks the Channel by its name.
- `connector: 'log'` picks the connector. The other options, here `label`, go to its `send()` function.
- `send()` does not throw. It returns `[error, receipt]`. Check `error` first.

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and send a request:

```bash [commands/request]
curl -X POST http://localhost:5173/api/build-finished
```

The response is the receipt. `deliveryId` is a new id that ViteHub makes for each send. `id` comes from your connector.

```json [output/response.json]
{
  "channel": "alerts",
  "connector": "log",
  "deliveryId": "...",
  "id": "log-release"
}
```

The terminal that runs Vite also shows `[release] Build finished.`. This tells you that the connector ran.

::

## Connect a real service

To send to a real service, add a connector that calls its API. Read the API key from Server Env inside `send()`. Do not put the key in client code. Channels does not retry a failed delivery.

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code-2" to="/docs/channels/server-api#send-from-an-h3-or-nitro-handler"}
Read the receipt, add a second connector, and see the delivery logs.
:::

:::card{title="Send through a Chat channel" icon="i-lucide-message-square" to="/docs/channels/server-api#send-through-a-chat-channel"}
Send to Slack, Teams, Discord, or Telegram with a ready connector.
:::
::
