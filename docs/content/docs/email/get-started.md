---

title: Send your first Email
description: Configure Resend with a secret, send a welcome email from server code, and check the delivery result.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Email sends messages from your server code through a provider, such as Resend. You write the message once, and the provider delivers it.

In this tutorial, you send a real welcome email from an API route through Resend and check that it arrives.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation) and a POSIX shell, such as bash or zsh. You also need a Resend account with an API key, a verified sender address in Resend, and an inbox you can check. Run every command from the app root. The last step sends a real email.

::tutorial-step{title="Install the email dependencies"}
## Install the email dependencies

Install the Email package, which includes the Resend driver.

```bash pm [commands/install]
pnpm add @vite-hub/email
```

::

::tutorial-step{title="Configure Resend"}
## Configure Resend

Add `email` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep your other options.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
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
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
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
- `apiKey` reads `RESEND_API_KEY` from the environment when the server sends an email. Do not write the key itself in this file, because config values go into the build output.
- `remote: true` tells `vite dev` to send real email. Without it, `vite dev` keeps each email in the [development outbox](/docs/email/hosts#development-outbox) and sends nothing to Resend. A build ignores `remote`.

::

::tutorial-step{title="Provide the Resend secret"}
## Provide the Resend secret

Set `RESEND_API_KEY` in the same terminal where you start Vite. Replace `re_...` with your API key. A variable that you set in another terminal does not reach the server.

```bash [commands/secret]
export RESEND_API_KEY='re_...'
```

In production, put the key in the secret store of your host. Do not start the variable name with `VITE_`, because Vite can send `VITE_` values to the browser.

::

::tutorial-step{title="Send from server code"}
## Send from server code

Create `server/api/welcome.post.ts` and update the two addresses:

- Set `from` to your verified Resend sender address.
- Set `to` to an inbox you can check.

Every request to this route sends a real email.

```ts [server/api/welcome.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email'

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

`email.send()` returns `[error, sent]`. Check `error` for delivery failures. Configuration errors, such as a missing provider, can throw. In `vite dev`, the [development outbox](/docs/email/hosts#development-outbox) also keeps a copy of each email.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the dev server in the terminal where you set the key:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal and call the route:

```bash [commands/request]
curl -X POST http://localhost:3000/api/welcome
```

When Resend accepts the email, the response looks like this:

```json [output/response.json]
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

Resend returns the message `id`. On the first send, the server terminal also prints:

```text [output/terminal.txt]
[vitehub] Email is remote: `vite dev` sends real email through resend.
```

If the key is wrong, the request fails with `EMAIL_AUTHENTICATION: The resend Email provider rejected the credentials.` in the server terminal. If `RESEND_API_KEY` is missing in that terminal, the request fails with `ENV_R0010`.

Now check your inbox for the email. You can also look in the Resend delivery log. An `id` means that Resend accepted the email. It does not mean that the email got to the inbox.

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
