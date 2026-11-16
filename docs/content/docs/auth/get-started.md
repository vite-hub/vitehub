---
title: Create your first Auth session
description: Sign up a user with an email and a password, then read their session with the saved cookie.
navigation.title: Get started
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Auth lets people sign up and sign in to your app. It uses [Better Auth](https://www.better-auth.com), a sign-in library, to do the work. You write one small file, and ViteHub connects it to your server.

In this tutorial, you sign up a user with an email and a password. Then you use the cookie from the sign-up to read the user's session.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands in the root folder of the app. You need no account and no API key.
>
> This tutorial keeps users and sessions in memory. When the server restarts, they are gone. Before you use Auth in production, keep users in a database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

::tutorial-step{title="Install and configure"}
## Install and configure

Add Auth, Better Auth, and Drizzle to your app. Auth uses the `drizzle-orm` of your app, so the app has one copy:

```bash pm [commands/install]
pnpm add @vite-hub/auth better-auth drizzle-orm@1.0.0-rc.5
```

Add `auth: true` to the ViteHub options of your app. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', auth: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', auth: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', auth: true })],
})
```
::::
:::


::

::tutorial-step{title="Define Auth"}
## Define Auth

Create `server/auth.ts`:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

- ViteHub finds this file. Better Auth then answers all requests to `/api/auth/**`.
- `emailAndPassword.enabled` turns on sign-up and sign-in with an email and a password. You do not write these routes yourself.

::

::tutorial-step{title="Create and verify one session"}
## Create and verify one session

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal, and sign up a user:

```bash [commands/sign-up]
curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

- `-c cookies.txt` saves the session cookie of the response in a file.
- The password is example data. Use a different password for a real account.

The response status is `200`. The body has the session token and the new user. The `set-cookie` header has the session cookie, `better-auth.session_token`:

```json [output/sign-up.json]
{"token":"NTWzzKcdSkNKwQpbjhNLNmB5ZtLMYc02","user":{"name":"Ada Lovelace","email":"ada@example.com","emailVerified":false,"createdAt":"2026-11-07T14:32:09.084Z","updatedAt":"2026-11-07T14:32:09.084Z","id":"CWbbjvJcxFqsNk4gJaVzO8uo0RADDsTY"}}
```

Now send the saved cookie back, and read the session:

```bash [commands/session]
curl -i -b cookies.txt http://localhost:3000/api/auth/get-session
```

The response has the `session`, with `expiresAt`, the time when the session ends, and the signed-in `user`. The cookie proved who you are. Without the cookie, or after a restart of the server, the response is `null`.

::

## What happens when you deploy

The memory store of this tutorial is only for local tests. It loses all users when the server stops, so a production build fails with `AUTH_C0063`. Before you deploy, choose one of these:

- Keep users in your app Database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).
- Use [Sessions without a database](/docs/auth/configure#sessions-without-a-database) when people sign in only with a social account, such as GitHub.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/auth/configure"}
Keep users in a database, set the secret, and add rate limits.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/auth/server-api"}
Protect your routes so that only signed-in users can use them.
:::

:::card{title="Abilities" icon="i-lucide-shield-check" to="/docs/auth/abilities"}
Write each permission rule once and check it on the server and in Vue.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/auth/hosts"}
See what Auth needs on each host.
:::
::
