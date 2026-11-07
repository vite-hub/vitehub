---

title: Send your first Email
description: Install Email, configure Resend with a secret, send a welcome email from server code, and check the delivery result.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Email sends email from your server code. You write the message once. A provider, such as Resend, delivers it.

In this tutorial, you send a real welcome email through Resend from an API route, and you check that it arrived.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer, Vite 8 or newer, pnpm, a Vite app, and a POSIX shell such as bash or zsh. You also need a Resend account with an API key, a sender address that Resend verified, and an inbox that you can check. Run the commands from the root of the app. The last step sends a real email.

::tutorial-step{title="Install the email dependencies"}
## Install the email dependencies

Install ViteHub. Nitro is the server that runs your API routes. The Resend driver comes with ViteHub, so you install no other package.

```bash pm [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure Resend"}
## Configure Resend

Add `email` to `vitehub()` in `vite.config.ts`. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
      remote: true,
    },
  },
})
```
::::

::::tabs-item{label="Nitro"}
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
      remote: true,
    },
  }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
      remote: true,
    },
  })],
})
```
::::
:::

- `driver: 'resend'` sends the email through Resend.
- `apiKey` reads the key from the `RESEND_API_KEY` environment variable when the server sends an email. Do not write the key itself in this file. Values in the config go into the build output.
- `remote: true` makes `vite dev` send real email. Without it, `vite dev` keeps each email in the [development outbox](/docs/email/hosts#development-outbox) and sends nothing to Resend. A build ignores `remote`.

::

::tutorial-step{title="Provide the Resend secret"}
## Provide the Resend secret

Set `RESEND_API_KEY` in the terminal where you start Vite. Replace `re_...` with your API key. A variable that you set in another terminal does not get to the server.

```bash [commands/secret]
export RESEND_API_KEY='re_...'
```

In production, put the key in the secret store of your host. Do not start the name with `VITE_`. Vite can send `VITE_` values to the browser.

::

::tutorial-step{title="Send from server code"}
## Send from server code

Create `server/api/welcome.post.ts`. Then change the two addresses:

- Set `from` to the sender address that Resend verified.
- Set `to` to an inbox that you can check.

Each request to this route sends one more real email.

```ts [server/api/welcome.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email/server'

export default defineEventHandler(async () => {
  const [error, sent] = await email.send({
    from: 'verified-sender@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Welcome to ViteHub.',
  })
  if (error) throw error
  return sent
})
```

`email.send()` does not throw. It returns `[error, sent]`. Check `error` first. In `vite dev`, the [development outbox](/docs/email/hosts#development-outbox) also keeps a copy of each email.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the dev server in the terminal where you set the key:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and call the route:

```bash [commands/request]
curl -X POST http://localhost:5173/api/welcome
```

When Resend accepts the email, the response looks like this:

```json [output/response.json]
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

`id` comes from Resend. The first send also prints `[vitehub] Email is remote` in the server terminal.

Now open the inbox and find the email. You can also look in the Resend delivery log. An `id` tells you that Resend accepted the email. It does not tell you that the email got to the inbox.

::

## Next steps

::card-group
:::card{title="Development outbox" icon="i-lucide-inbox" to="/docs/email/hosts#development-outbox"}
Test emails in `vite dev` without sending them.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/email/server-api"}
See the message fields and write emails in Markdown.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/email/configure#configure-another-provider"}
Use a provider other than Resend.
:::
::
