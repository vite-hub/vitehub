---

title: Send and receive through your first Channel
description: Define a named Channel, send a local build notification from server code, and receive a signed webhook.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Define a Channel named `alerts`. First it sends a build notification through an adapter that writes to the server terminal. Then it receives a signed webhook and runs a handler once per delivery. No message leaves your machine and no provider key is needed.

You need Node.js 22.22 or newer, pnpm, and a Vite application. Run the commands from its root. Nitro serves the routes.

::tutorial-step{title="Install and enable Channels"}
## Install and enable Channels

Install ViteHub and Nitro. Add the plugins below to your existing Vite config, keeping its other plugins.

```bash [commands/install]
pnpm add vite-hub @vite-hub/channels @vite-hub/agent @vite-hub/workflow nitro h3 vite
```

`channels: true` discovers the files below `server/channels`. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder. Other files in that folder are helpers. Inbound webhooks run on the Agent webhook route, so a Channel that receives webhooks also needs `agent: true`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', agent: true, channels: true })],
})
```

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts` with `defineChannel()`. The adapter is the connection. This one has a `send` function that prints the text and returns a receipt, so we can check the code without a real service.

```ts [server/channels/alerts.ts]
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({
  adapter: {
    kind: 'log',
    send(text: string, { label }: { label: string }) {
      console.log(`[${label}] ${text}`)
      return { id: `log-${label}` }
    },
  },
})
```

The file name becomes the Channel name.

::

::tutorial-step{title="Send one message"}
## Send one message

`useChannel('alerts')` selects the Channel. `send()` passes the text and the options to the adapter. Check the error before you return the receipt.

```ts [server/api/build-finished.post.ts] fragment
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', { label: 'release' })
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

The terminal running Vite prints `[release] Build finished.`, and the response has the receipt:

```json [output/response.json]
{
  "channel": "alerts",
  "deliveryId": "...",
  "id": "log-release"
}
```

::

::tutorial-step{title="Receive a signed webhook"}
## Receive a signed webhook

Create `server/channels/builds.ts`. The `webhook()` adapter checks `Authorization: Bearer <secret>`, and `on` runs a handler for each delivery. The default event name is `webhook`.

```ts [server/channels/builds.ts]
import { defineChannel, webhook } from 'vite-hub/channels'

export default defineChannel({
  adapter: webhook<{ id: string }>({ signature: 'bearer', secret: 'local-secret' }),
  on: {
    webhook: event => console.log(`build ${event.data.id} finished (delivery ${event.id})`),
  },
})
```

Every Channel that receives webhooks has the route `/api/_vitehub/channels/<name>`. Send the same body twice:

```bash [commands/webhook]
curl -X POST http://localhost:5173/api/_vitehub/channels/builds \
  -H 'authorization: Bearer local-secret' -H 'content-type: application/json' \
  -d '{"id":"build-42"}'
```

The handler runs once. The second request answers `{ "duplicate": true }`, because the delivery ID, the SHA-256 of the body here, is the same. A request without the secret answers 401. Read secrets from Server Env in a real app, and continue with [Receive webhooks](/docs/channels/server-api#receive-webhooks).
::
