---

title: Send your first Email
description: Install Email, configure Resend with a secret, send a welcome email from server code, and check the delivery result.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You send a welcome email through Resend, an email service, from an API route in your app. At the end, the email is in your inbox. This tutorial sends a real email.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app on Vite 8 or newer
- a terminal that runs `bash` or `zsh` (macOS, Linux, or WSL on Windows)
- a Resend account, with an API key and a sender address that Resend verified
- an inbox that you can check

You do not need a mail server. Run all commands from the app root.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

`vite-hub` sends the email. It already contains the code that talks to Resend, so you do not install a Resend package. `nitro` and `h3` serve the API route. `vite` runs the app.

::

::tutorial-step{title="Connect Resend"}
## Connect Resend

Add Email to the `vitehub()` options in `vite.config.ts`:

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

- `preset: 'node'` builds the app for a Node.js server. ViteHub also adds Nitro, the server that runs your API routes.
- `driver: 'resend'` sends the email through Resend.
- `apiKey` tells the server to read the key from the `RESEND_API_KEY` environment variable when it sends a message. `secret: true` marks the value as a secret. Do not write the key itself in this file, because values in the config go into the build output.
- `remote: true` makes `vite dev` send real email. Without it, `vite dev` keeps each email in the [development outbox](/docs/email/hosts#development-outbox), a local list of messages, and does not call Resend. A production build ignores `remote`.

::

::tutorial-step{title="Set the API key"}
## Set the API key

Set `RESEND_API_KEY` in the terminal where you will start the app. Replace `re_...` with your API key:

```bash [commands/secret]
export RESEND_API_KEY='re_...'
```

The server reads only the environment of the terminal that starts it. An `export` in a different terminal does not reach the server.

> [!NOTE]
> Do not start the name with `VITE_`. Vite can put `VITE_` values in browser code. In production, use the secret store of your host.

::

::tutorial-step{title="Write the route"}
## Write the route

Create `server/api/welcome.post.ts`. Replace `from` with your address that Resend verified. Replace `to` with your inbox.

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

`email.send()` does not throw. It returns `[error, sent]`. If the send fails, `error` tells you why. If it works, `sent` has the message ID.

::

::tutorial-step{title="Send the email"}
## Send the email

Start the app:

```bash [commands/start]
pnpm vite dev
```

Keep it running. In a second terminal, call the route. Each call sends one more email.

```bash [commands/request]
curl -X POST http://localhost:5173/api/welcome
```

You see:

```json [output/response.json]
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

`id` comes from Resend. It proves that Resend accepted the message. The server terminal also prints `[vitehub] Email is remote` on the first send. The development outbox keeps a copy of the message too.

Now check your inbox, or the email log in Resend. An ID means that Resend accepted the email. It does not prove that the email reached the inbox.

::

## Next steps

- [Hosts](/docs/email/hosts#development-outbox): read the development outbox, and test emails without sending them.
- [Configure](/docs/email/configure#configure-another-provider): send through another email service.
- [Limits and errors](/docs/email/limits-and-errors): handle each delivery error.
