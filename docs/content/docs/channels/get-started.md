---

title: Send and receive through your first Channel
description: Define a named Channel, send a local build notification from server code, and receive a signed webhook.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Channel is a named connection your server uses to send and receive messages. An adapter connects it to a service, such as Slack, or to your own code.

In this tutorial, you create an `alerts` Channel that writes "Build finished." to your terminal. Then you create a `builds` Channel that receives a signed webhook and runs a handler once per delivery.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need no account or API key. No message leaves your computer.

::tutorial-step{title="Install and enable Channels"}
## Install and enable Channels

Add Channels and the Agent package, which serves the webhook route:

```bash pm [commands/install]
pnpm add @vite-hub/channels @vite-hub/agent
```

You add no option. The Channel files in `server/channels` turn on Channels, and a Channel that receives webhooks turns on the webhook route of the Agent package. Keep `vitehub()` in `vite.config.ts`, or `vite-hub/nuxt` in `nuxt.config.ts`, as in [Installation](/docs/getting-started/installation).


:::details{summary="How ViteHub finds Channel files"}
ViteHub discovers files under `server/channels` and files ending in `.channel.ts`. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder. Other files in that folder are helpers. Discovery skips modules whose default export cannot be a Channel, such as a function, an array, or an object literal without `adapter`.
:::

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts`. ViteHub names the Channel `alerts` after the file:

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
- `send()` receives the message text and your options, here `label`.
- `send()` returns a receipt with an `id`. A service adapter returns the provider's message ID.

::

::tutorial-step{title="Send one message"}
## Send one message

Create an API route that sends a message to `alerts`:

```ts [server/api/build-finished.post.ts] fragment
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', { label: 'release' })
  if (error) throw error
  return receipt
})
```

- `useChannel('alerts')` looks up the Channel by name.
- `send()` passes the text and the options, here `label`, to the adapter.
- `send()` returns `[error, receipt]`. Check `error` for input, discovery, and adapter failures. If no Channel Definition was discovered for the name, `send()` returns `[error, undefined]` with code `CHANNEL_DEFINITION_FAILED`. An empty or whitespace-only name throws immediately in `useChannel()`.

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal and send a request:

```bash [commands/request]
curl -X POST http://localhost:3000/api/build-finished
```

The Vite terminal prints `[release] Build finished.`, and the response has the receipt:

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

Create `server/channels/builds.ts`. A webhook is an HTTP request that a service sends to tell your app about an event:

```ts [server/channels/builds.ts]
import { defineChannel } from 'vite-hub/channels'
import { webhook } from 'vite-hub/channels/adapters'

export default defineChannel({
  adapter: webhook<{ id: string }>({ signature: 'bearer', secret: 'BUILDS_WEBHOOK_SECRET' }),
  on: {
    webhook: event => console.log(`build ${event.data.id} finished (delivery ${event.id})`),
  },
})
```

- `secret` is the name of the server variable that holds the secret, not the secret itself.
- `webhook()` checks the secret in the `Authorization: Bearer <secret>` header.

Set the variable in `.env` and restart the dev server:

```bash [.env]
BUILDS_WEBHOOK_SECRET=local-secret
```

- `on.webhook` runs the handler for each delivery. `webhook` is the default event name.

Stop the dev server and run `pnpm dev` again. ViteHub enables the webhook host at startup when it finds your first inbound Channel.

Every Channel that receives webhooks has the route `/_vitehub/channels/<name>`. Send the same body twice:

```bash [commands/webhook]
curl -X POST http://localhost:3000/_vitehub/channels/builds \
  -H 'authorization: Bearer local-secret' -H 'content-type: application/json' \
  -d '{"id":"build-42"}'
```

The handler runs once. Because `webhook()` hashes the body to make the delivery ID, the second request has the same ID and returns `{ "duplicate": true }`. A request without the secret returns 401.
::

## Connect a real service

Use an adapter that calls the service API. Read its API key or webhook secret from Server Env, so the secret stays in server code. Channels does not retry a failed outbound send.

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code-2" to="/docs/channels/server-api#send-a-message"}
Read the receipt and see the delivery logs.
:::

:::card{title="Send through a chat adapter" icon="i-lucide-message-square" to="/docs/channels/server-api#send-through-a-chat-adapter"}
Send to Slack, Teams, Discord, or Telegram with built-in adapters.
:::

:::card{title="Receive webhooks" icon="i-lucide-webhook" to="/docs/channels/server-api#receive-webhooks"}
Receive events from a service and choose how to handle them.
:::
::
