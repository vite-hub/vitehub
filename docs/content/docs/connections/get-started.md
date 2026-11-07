---

title: Connect your first provider account
description: Define a Connection, connect a Google account with OAuth, and call the Gmail API to read the account's labels.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You connect a Google account to your app. Then a server route lists the Gmail labels of that account. At the end, `curl` shows the labels.

When a user connects an account, Google gives your app a grant: the right to call Google as that user. Connections keeps the grant in your app's database and adds it to each request to Google. Your route never handles a token.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.
- a Google OAuth client, with the Gmail API turned on, in Google Cloud
- a Google test account that the consent screen of your OAuth client allows

You do not need to set up a database. Connections turns on [Database](/docs/database/get-started) and uses its `default` database. This example only reads labels. It does not send or change mail.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3 @vite-hub/database drizzle-orm
pnpm add -D vite
```

- `vite-hub` gives you Connections.
- `nitro` and `h3` serve the API route.
- `@vite-hub/database` and `drizzle-orm` store the grants.

Turn on Connections in `vite.config.ts`:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: { auth: false }, connections: true })],
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

- `preset: 'node'` tells ViteHub that the app runs on a Node.js server.
- `console: { auth: false }` turns on the Console, the ViteHub admin page, with no sign-in. Use this only on your own computer.
- `env.server.google` reads the Google client ID and secret from the server environment variables `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `secret: true` hides the value until your code unseals it.

Connections encrypts each grant with a key. Make a random key:

```bash [commands/secret]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Save the key in a password manager or secret store, and use the same key after each restart. With a new key, the app cannot open the old grants, and you must connect those accounts again.

In the terminal where you will start Vite, set the key and the Google credentials:

```bash [commands/credentials]
export VITEHUB_CONNECTIONS_KEY='paste-the-generated-key'
export GOOGLE_CLIENT_ID='your-google-client-id'
export GOOGLE_CLIENT_SECRET='your-google-client-secret'
```

In Google Cloud, add `http://localhost:5173/_vitehub/connections/callback` as an authorized redirect URI. Google sends the user back to this URL after sign-in. Its host and port must match the URL that you open in your browser.

::

::tutorial-step{title="Define a Connection"}
## Define a Connection

A Connection describes one provider account that your app can use. Create `server/connections/google.ts`. The file name gives the Connection the name `google`.

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

- `provider: google()` uses Google sign-in with your client ID and secret. `useServerEnv()` reads the values that you declared in `vite.config.ts`. `.unseal()` reads the hidden secret value.
- `scopes` lists what the app asks Google for. `gmail.readonly` lets it read mail data, but not change it. `google()` also adds the `openid` and `email` scopes, so you can see which account connected.
- `api` lists the Gmail methods that your code can call. Here it is only `users.labels.list`.
- `access` allows server code to read and denies writes.

::

::tutorial-step{title="Connect the account"}
## Connect the account

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

You can connect the account in two ways. In the Console, select **Connections**, then **Connect**. Or use the CLI, as below.

Keep the server running. In another terminal, run the first command. It prints a connect URL that works one time. Open the URL in your browser, sign in with the test account, and accept the consent screen. When the browser comes back to the app, run the second command:

```bash [commands/connect]
pnpm vitehub connections connect google
pnpm vitehub connections status google --json
```

The status shows a connected account. This proves that Connections got the grant from Google and saved it.

::

::tutorial-step{title="Call the provider"}
## Call the provider

Create a route that calls Gmail as the connected account:

```ts [server/api/labels.get.ts]
import { defineEventHandler } from 'h3'
import { useConnection } from 'vite-hub/connections/server'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google', { event })
  const [error, data] = await connection.gmail.users.labels.list({ userId: 'me' })
  if (error) throw error
  return data
})
```

- `useConnection('google', { event })` gets the `google` Connection. `{ event }` tells Connections which route makes the call. It uses this for the access rules and the activity log.
- `userId: 'me'` tells Gmail to use the connected account.
- The call returns `[error, data]`. If `error` is set, the route throws it.

Call the route:

```bash [commands/request]
curl http://localhost:5173/api/labels
```

```json [output/response.json]
{ "labels": [] }
```

You see a `labels` array. Gmail can also return its own labels, such as `INBOX`, so the array is often not empty. This proves that your route called Gmail as the connected account, and that it never read a token.

::

## Next steps

- [Server API](/docs/connections/server-api): call providers from routes, and use the Connections CLI.
- [Access rules](/docs/connections/configure#access-rules): choose what server code, routes, and Agents can do, and when a call needs approval.
- [API key Connections](/docs/connections/configure#api-key-connections): connect a provider that uses an API key, not OAuth.
