---

title: Send through your first Channel
description: Send a local build notification and inspect the connector receipt.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Send a build notification through a Channel named `alerts`. Your first connector writes to the server terminal and returns a receipt. This lets you check the delivery code before connecting a messaging service.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. Nitro serves the API route. No message leaves your machine and no provider key is needed.

::tutorial-step{title="Install and enable discovery"}
## Install and enable discovery

Install ViteHub and Nitro. Add the plugins below to your existing Vite config, keeping its other plugins.

```bash [commands/install]
pnpm add vite-hub nitro h3 vite
```

Add the Channels integration to your Vite config. ViteHub then discovers files below `server/channels` and files that end in `.channel.ts`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true }), nitro() as never],
})
```

The local connector does not need Server Env. Add a secret declaration only
when a connector calls a provider API.

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts` with `defineOutboundChannel()`. The `log`
connector returns a receipt that we can inspect without sending a real message.

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

The file name becomes the Channel name. For a Vite suffix definition, use `src/alerts.channel.ts` instead; both forms discover the same `alerts` Channel.

::

::tutorial-step{title="Send and verify one delivery"}
## Send and verify one delivery

`useChannel('alerts')` selects the Definition; `connector: 'log'` selects its send function. That function receives the label and text. Check the tuple's error before returning its receipt.

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

Start the dev server and send one request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/build-finished
```

The response includes a generated delivery id and the connector id:

The terminal running Vite also prints `[release] Build finished.`. This confirms that the connector ran, while the HTTP response confirms that the caller received its receipt.

```json [output/response.json]
{
  "channel": "alerts",
  "connector": "log",
  "deliveryId": "...",
  "id": "log-release"
}
```

Channels does not bundle provider adapters or retry deliveries. For a real
connector, read typed Server Env inside `send()` and keep credentials out of
client code. Continue with [Send from an H3 or Nitro handler](/docs/channels/server-api#send-from-an-h3-or-nitro-handler).
::
