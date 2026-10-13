---

title: Connect your first provider account
description: Connect a Google account with OAuth and read its Gmail labels.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Connect a Google account, then list its Gmail labels from a server route. Connections stores the OAuth grant in your app database and adds the credential to provider requests. Your route receives the label data without reading a token.

You need Node.js 24.15 or newer, pnpm, and a Vite application with [Database](/docs/database/get-started) configured. You also need a Google OAuth client with Gmail API access and a test account permitted by its consent screen. Run the commands from the app root. This example reads labels and does not send or change mail.

::tutorial-step{title="Install and configure"}
## Install and configure

Install ViteHub and Nitro. Keep your existing Database Definition and add these integrations to the app's Vite config.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Merge these options with your existing Database configuration. The Env declarations read the Google client credentials from the server environment.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: true, database: true, connections: true }), nitro() as never],
  env: {
    server: {
      google: {
        clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
        clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
      },
    },
  },
})
```

```bash [commands/secret]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Save the printed key in a secret store and reuse it after restarts. Generating a new key prevents the app from opening existing grants, so you must reconnect those accounts. In the terminal where you will start Vite, set the key and Google credentials:

```bash [commands/credentials]
export VITEHUB_CONNECTIONS_KEY='paste-the-generated-key'
export GOOGLE_CLIENT_ID='your-google-client-id'
export GOOGLE_CLIENT_SECRET='your-google-client-secret'
```

In Google Cloud, add `http://localhost:5173/_vitehub/connections/callback` as an authorized redirect URI. The origin must match the local URL you use in your browser.

::

::tutorial-step{title="Define a Connection"}
## Define a Connection

The file name registers the Connection as `google`. The Google provider adds `openid` and `email` scopes to identify the account during consent.

Create a read-only Gmail Connection. `api` selects the typed methods available to callers. The access rule allows server reads and denies writes.

```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    clientId: () => useServerEnv().google.clientId,
    clientSecret: () => useServerEnv().google.clientSecret.unseal(),
  }),
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  api: { gmail: ['users.labels.list'] },
  access: {
    server: { read: true, write: false },
  },
})
```

::

::tutorial-step{title="Connect the account"}
## Connect the account

Open the Console, select **Connections**, and select **Connect**. You can also print a single-use connect URL from the CLI while the development server runs:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run the connect command below.

Open the connect URL printed by the first command in your browser. Sign in with the test account and accept the consent screen. Run the status command after the browser returns to the app.

```bash [commands/connect]
pnpm vitehub connections connect google
pnpm vitehub connections status google --json
```

The status should report a connected account.
::

::tutorial-step{title="Call the provider"}
## Call the provider

The route calls Gmail as the connected account. `userId: 'me'` tells Gmail to use that account, and `{ event }` identifies the route in access checks and activity.

```ts [server/api/labels.get.ts]
import { defineEventHandler } from 'h3'
import { useConnection } from 'vite-hub/connections/server'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google', { event })
  return await connection.gmail.users.labels.list({ userId: 'me' })
})
```

Request the route and verify that
the provider returns a `labels` array:

```bash [commands/request]
curl http://localhost:5173/api/labels
```

```json [output/response.json]
{ "labels": [] }
```

Gmail may return system labels, so the array is not always empty. Read [Server
API](/docs/connections/server-api) for access rules, approvals, and API-key
Connections.
::
