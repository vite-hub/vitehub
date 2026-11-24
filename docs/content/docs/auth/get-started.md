---
title: Create your first Auth session
description: Sign up a user with an email and a password, then read their session with the saved cookie.
navigation.title: Get started
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Auth lets people sign up and sign in to your app. It uses [Better Auth](https://www.better-auth.com), a sign-in library, to do the work. You write one small file, and ViteHub connects it to your server.

In this tutorial, you sign up a user with an email and password, then use the saved cookie to read their session.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation) and run commands in the app root. You need no account or API key.
>
> This tutorial keeps users and sessions in memory, so a server restart clears them. Before deploying, store users in a database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

::tutorial-step{title="Install"}
## Install

Install Auth, Better Auth, and Drizzle. Auth uses your app's `drizzle-orm`, so the app has one copy:

```bash pm [commands/install]
pnpm add @vite-hub/auth better-auth drizzle-orm@1.0.0-rc.6
```

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

- This file turns Auth on. You do not add an `auth` option. Better Auth handles all requests to `/api/auth/**`.
- `emailAndPassword.enabled` turns on email and password sign-up and sign-in routes for you.

::

::tutorial-step{title="Create and verify one session"}
## Create and verify one session

Start the dev server:

```bash [commands/start]
pnpm dev
```

Leave the server running, open a second terminal, and sign up a user:

```bash [commands/sign-up]
curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

- `-c cookies.txt` saves the session cookie from the response to a file.
- The password is sample data. Use a different password for a real account.

The response has status `200`, a session token, and the new user. The `set-cookie` header has the session cookie, `better-auth.session_token`:

```json [output/sign-up.json]
{"token":"NTWzzKcdSkNKwQpbjhNLNmB5ZtLMYc02","user":{"name":"Ada Lovelace","email":"ada@example.com","emailVerified":false,"createdAt":"2026-11-07T14:32:09.084Z","updatedAt":"2026-11-07T14:32:09.084Z","id":"CWbbjvJcxFqsNk4gJaVzO8uo0RADDsTY"}}
```

Now send the saved cookie back to read the session:

```bash [commands/session]
curl -i -b cookies.txt http://localhost:3000/api/auth/get-session
```

The response has the signed-in `user` and the `session`. `expiresAt` is the time when the session ends. The cookie proved who you are. Without the cookie, or after a server restart, the response is `null`.

::

## What happens when you deploy

The in-memory store is only for local testing. It loses all users when the server stops, so a production build fails with `AUTH_C0063`. Before you deploy, pick one of these:

- Store users in your app Database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).
- Use [Sessions without a database](/docs/auth/configure#sessions-without-a-database) if people sign in only with a social account such as GitHub.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/auth/configure"}
Store users in a database, set the secret, and add rate limits.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/auth/server-api"}
Protect your routes so only signed-in users can use them.
:::

:::card{title="Abilities" icon="i-lucide-shield-check" to="/docs/auth/abilities"}
Write each permission rule once and check it on the server and in Vue.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/auth/hosts"}
See what Auth needs on each host.
:::
::
