---

title: Connect your first provider account
description: Define a Connection, connect a Google account with OAuth, and call the Gmail API to read the account's labels.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Connection lets your server call another service, such as Gmail, as a user who signed in to that service once. ViteHub keeps the user's access in your database and adds it to each call. Your code never reads a token.

In this tutorial, you connect a Google account and list its Gmail labels from an API route. The example only reads labels. It does not send or change mail.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). You also need a Google OAuth client with access to the Gmail API, and a test account that its consent screen allows. Connections turns on [Database](/docs/database/get-started) to store the access, but you do not need to define a database. Run every command from the app root.

::tutorial-step{title="Install and configure"}
## Install and configure

Add Connections and the Database packages that store its data:

```bash pm [commands/install]
pnpm add @vite-hub/connections @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

Then update the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep the other options of your app:

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
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
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
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
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
    },
  })],
})
```
::::
:::

- `connections: true` turns on Connections.
- `env.server.google` reads your Google client ID and secret from environment variables. `secret: true` hides the value until your code calls `unseal()`.

Connections encrypts what it stores with a key. Make a random key:

```bash [commands/secret]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Save the key in a safe place, such as a password manager, and use the same key each time. With a new key, the app cannot read the accounts that you connected before, so you must connect them again.

In the terminal where you will start the dev server, set the key and your Google values:

```bash [commands/credentials]
export VITEHUB_CONNECTIONS_KEY='paste-the-generated-key'
export GOOGLE_CLIENT_ID='your-google-client-id'
export GOOGLE_CLIENT_SECRET='your-google-client-secret'
```

In Google Cloud, add `http://localhost:3000/_vitehub/connections/callback` and `http://127.0.0.1:4799/callback` as authorized redirect URIs. Google sends the user back to these URLs after you connect.

::

::tutorial-step{title="Define a Connection"}
## Define a Connection

Create `server/connections/google.ts`. The file name is the name of the Connection: `google`. This Connection can only read Gmail.

```ts [server/connections/google.ts]
import { useServerEnv } from 'vite-hub/env'
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
    server: { read: true },
  },
})
```

- `scopes` lists what the user lets your app do. `gmail.readonly` allows reads only. The Google provider also asks for `openid` and `email`, to know which account signed in.
- `api` lists the Gmail methods that your code can call. Here, only `users.labels.list`.
- `access.server` lets server code read. It has no `write` rule, so server code cannot write.

::

::tutorial-step{title="Connect the account"}
## Connect the account

Start the dev server in the terminal where you set the keys:

```bash [commands/start]
pnpm dev
```

To connect the account, use the CLI. Open a second terminal and run the first command below. It prints a connect URL that works one time, and waits on `http://127.0.0.1:4799/callback`. Open that URL in your browser, sign in with the test account, and accept the consent screen. When the command ends, run the second command:

```bash [commands/connect]
pnpm vitehub connections connect google --port 4799
pnpm vitehub connections inspect google --json
```

Before you connect, `inspect` shows `"status": "disconnected"` and the Gmail scope in `scopes.missing`. After you connect, it shows `"status": "connected"` and the account.

::

::tutorial-step{title="Call the provider"}
## Call the provider

Create `server/api/labels.get.ts`. This route calls Gmail as the connected account.

```ts [server/api/labels.get.ts]
import { defineEventHandler } from 'h3'
import { useConnection } from 'vite-hub/connections/server'

export default defineEventHandler(async () => {
  const connection = useConnection('google')
  const [error, data] = await connection.gmail.users.labels.list({ userId: 'me' })
  if (error) throw error
  return data
})
```

- `useConnection('google')` gives you the `google` Connection. The call runs as the `server` actor, so the `access.server` rule applies.
- `userId: 'me'` tells Gmail to use the connected account.
- The call returns an `[error, data]` pair. Throw the error, or return the data.

Call the route:

```bash [commands/request]
curl http://localhost:3000/api/labels
```

```json [output/response.json]
{ "labels": [] }
```

The response has a `labels` array. Gmail can add its own labels, so the array is often not empty.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/connections/configure"}
Add API key Connections, access rules, and every option.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/connections/server-api"}
Make calls, read the activity log, and use the CLI.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/connections/limits-and-errors"}
See how Connections stores data, and what each error means.
:::
::
