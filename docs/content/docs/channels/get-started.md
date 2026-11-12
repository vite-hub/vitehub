---

title: Send and receive through your first Channel
description: Define a named Channel, send a local build notification from server code, and receive a signed webhook.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Channel is a named connection that your server uses to send and receive messages. An adapter connects it to a service, such as Slack, or to your own code.

In this tutorial, you make an `alerts` Channel that writes "Build finished." to your terminal. Then you make a `builds` Channel that receives a signed webhook and runs a handler once per delivery.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key. No message leaves your computer.

::tutorial-step{title="Install and enable Channels"}
## Install and enable Channels

Add Channels and the Agent and Workflow packages that receive webhooks:

```bash pm [commands/install]
pnpm add @vite-hub/channels @vite-hub/agent @vite-hub/workflow
```

Add `channels: true` and `agent: true` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node', agent: true, channels: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true, channels: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true, channels: true })],
})
```
::::
:::

- `channels: true` finds Channel files in `server/channels`.
- `agent: true` serves the webhook route for Channels that receive messages.


:::details{summary="How ViteHub finds Channel files"}
ViteHub discovers files below `server/channels` and files that end in `.channel.ts`. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder. Other files in that folder are helpers. Discovery skips modules whose default export cannot be a Channel, such as a function, an array, or an object literal without `adapter`.
:::

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts`. The file name is the name of the Channel: `alerts`.

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

- `adapter` is the connection. This one writes to your terminal.
- `send()` gets the text and your options, here `label`.
- `send()` returns a receipt with an `id`. A real adapter returns the message id from the service.

::

::tutorial-step{title="Send one message"}
## Send one message

Create an API route that sends a message to `alerts`.

```ts [server/api/build-finished.post.ts] fragment
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', { label: 'release' })
  if (error) throw error
  return receipt
})
```

- `useChannel('alerts')` picks the Channel by its name.
- `send()` passes the text and the options, here `label`, to the adapter.
- `send()` returns `[error, receipt]`. Check `error` for input, discovery, and adapter failures. Invalid Channel Definitions or names passed to `useChannel()` can throw.

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal and send a request:

```bash [commands/request]
curl -X POST http://localhost:3000/api/build-finished
```

The terminal running Vite prints `[release] Build finished.`, and the response has the receipt:

```json [output/response.json]
{
  "channel": "alerts",
  "deliveryId": "...",
  "id": "log-release"
}
```

`deliveryId` is a new id that ViteHub makes for each send. `id` comes from your adapter.

::

::tutorial-step{title="Receive a signed webhook"}
## Receive a signed webhook

Create `server/channels/builds.ts`. A webhook is an HTTP request that a service sends to tell your app about an event.

```ts [server/channels/builds.ts]
import { defineChannel, webhook } from 'vite-hub/channels'

export default defineChannel({
  adapter: webhook<{ id: string }>({ signature: 'bearer', secret: 'local-secret' }),
  on: {
    webhook: event => console.log(`build ${event.data.id} finished (delivery ${event.id})`),
  },
})
```

- `webhook()` checks the secret in the `Authorization: Bearer <secret>` header.
- `on.webhook` runs the handler for each delivery. `webhook` is the default event name.

Every Channel that receives webhooks has the route `/api/_vitehub/channels/<name>`. Send the same body twice:

```bash [commands/webhook]
curl -X POST http://localhost:3000/api/_vitehub/channels/builds \
  -H 'authorization: Bearer local-secret' -H 'content-type: application/json' \
  -d '{"id":"build-42"}'
```

The handler runs once. The second request answers `{ "duplicate": true }`, because both requests have the same delivery ID. This adapter makes the ID from a hash of the body. A request without the secret answers 401.
::

## Connect a real service

Use an adapter that calls the service API. Read its API key or webhook secret from Server Env. Keep the secret in server code. Channels does not retry a failed outbound send.

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code-2" to="/docs/channels/server-api#send-a-message"}
Read the receipt and see the delivery logs.
:::

:::card{title="Send through a chat adapter" icon="i-lucide-message-square" to="/docs/channels/server-api#send-through-a-chat-adapter"}
Send to Slack, Teams, Discord, or Telegram with a ready adapter.
:::

:::card{title="Receive webhooks" icon="i-lucide-webhook" to="/docs/channels/server-api#receive-webhooks"}
Receive events from a service and choose how to handle them.
:::
::
