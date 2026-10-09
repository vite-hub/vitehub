---

title: Send your first Email
description: Send a welcome email with Resend and check the delivery result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Send a welcome email with Resend and check its delivery. You will configure the provider, supply its API key to the server, and call a route that sends the message. The development outbox also records it for inspection.

You need Node.js 24.15 or newer, Vite 8 or newer, pnpm, a Vite application, and a POSIX-compatible shell. You also need a Resend API key, a verified sender, and an inbox you can check. Run the commands from the app root. The final request sends a real email.

::tutorial-step{title="Install the email dependencies"}
## Install the email dependencies

Install ViteHub and Nitro. The distribution includes the Resend driver; you do not need a separate driver package.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure Resend"}
## Configure Resend

Add Email to your existing ViteHub configuration. `env.source('RESEND_API_KEY')` names the server environment variable that supplies the credential.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
    },
  }), nitro() as never],
})
```

The server reads the API key when it sends a message. Keep the key in the environment rather than placing its value in this config. Literal options are part of the build output.

::

::tutorial-step{title="Provide the Resend secret"}
## Provide the Resend secret

Set `RESEND_API_KEY` in the server process:

Replace `re_...` with your API key in the terminal where you will start Vite. An export in another terminal does not set the server's environment.

```bash [commands/secret]
export RESEND_API_KEY='re_...'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

::

::tutorial-step{title="Send from server code"}
## Send from server code

Replace both addresses with values accepted by Resend. The request performs a real delivery. In `vite dev`, the [development outbox](/docs/email/hosts#development-outbox) also records the message.

Replace the sender with a Resend-verified address and the recipient with an inbox you control. Each request to this route sends another message.

```ts [server/api/welcome.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email/server'

export default defineEventHandler(async () => {
  return await email.send({
    from: 'verified-sender@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Welcome to ViteHub.',
  })
})
```

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Nitro serves the `server/api` route. Start the server and send the request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/welcome
```

A successful response has this shape:

```json [output/response.json]
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

Resend supplies `id`. Confirm delivery in the recipient inbox or the provider's delivery log; an accepted message ID does not guarantee final inbox placement.

::
