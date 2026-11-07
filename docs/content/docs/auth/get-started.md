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
> You need Node.js 22.18 or newer, pnpm, and a Vite app. Run the commands in the root folder of the app. You need no account and no API key.
>
> This tutorial keeps users and sessions in memory. When the server restarts, they are gone. Before you use Auth in production, keep users in a database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

::tutorial-step{title="Install and configure"}
## Install and configure

Add Auth and Better Auth to your app:

```bash pm [commands/install]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth h3
pnpm add -D vite
```

Add `hubAuth()` to the plugins in `vite.config.ts`. Keep the other plugins of your app.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

::

::tutorial-step{title="Define Auth"}
## Define Auth

Create `server/auth.ts`:

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

- `hubAuth()` finds this file. Better Auth then answers all requests to `/api/auth/**`.
- `emailAndPassword.enabled` turns on sign-up and sign-in with an email and a password. You do not write these routes yourself.

::

::tutorial-step{title="Create and verify one session"}
## Create and verify one session

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal, and sign up a user:

```bash [commands/sign-up]
curl -i -c cookies.txt -X POST http://localhost:5173/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

- `-c cookies.txt` saves the session cookie of the response in a file.
- The password is example data. Use a different password for a real account.

The response status is `200`. The body has the new user and the session. The `set-cookie` header has the session cookie.

Now send the saved cookie back, and read the session:

```bash [commands/session]
curl -i -b cookies.txt http://localhost:5173/api/auth/get-session
```

The response has the signed-in user and the time when the session ends. The cookie proved who you are.

::

## What happens when you deploy

The memory store of this tutorial is only for local tests. It loses all users when the server stops. Before you deploy, choose one of these:

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

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/auth/hosts"}
See what Auth needs on each host.
:::
::
