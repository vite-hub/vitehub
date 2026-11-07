---
title: Create your first Auth session
description: Create an email-and-password user and verify their session with a saved cookie.
navigation.title: Get started
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

You add sign-up and sign-in to a Vite app. At the end, you create a user with `curl` and read that user's session back with the cookie that sign-up gave you.

You need:

- Node.js 22.18 or newer
- pnpm
- a Vite app. Run all commands from its root folder.

You do not need a database or an account with an auth provider.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth h3
pnpm add -D vite
```

- `@vite-hub/auth` connects auth to your app.
- `better-auth` does the real work: sign-up, sign-in, and sessions.
- `@vite-hub/runtime` and `h3` run the server routes.

Add the Auth plugin to your Vite config. Keep the other plugins of your app.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

`hubAuth()` finds your auth file and adds its routes to the app.

::

::tutorial-step{title="Write the auth file"}
## Write the auth file

Create `server/auth.ts`:

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

- `defineAuth()` takes the same options as Better Auth.
- `emailAndPassword.enabled` turns on sign-up and sign-in with an email and a password.

The plugin adds the Better Auth routes under `/api/auth/`. You do not write sign-up or session routes yourself.

::

::tutorial-step{title="Sign up and read the session"}
## Sign up and read the session

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open another terminal and sign up a user. `-c cookies.txt` saves the cookie from the response in a local file. The password is example data. Use a different password for a real account.

```bash [commands/sign-up]
curl -i -c cookies.txt -X POST http://localhost:5173/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

You see status `200`, the new user, a session, and a `set-cookie` header. This proves that the sign-up route works and that the user is signed in.

Now send the saved cookie back with `-b cookies.txt`:

```bash [commands/session]
curl -i -b cookies.txt http://localhost:5173/api/auth/get-session
```

The JSON response shows the signed-in user and the time the session ends. This proves that the server knows the user from the cookie alone.

> [!NOTE]
> This example keeps users and sessions in memory. When you restart the server, they are gone. Before you use it in production, keep users in a database with [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

::

## Next steps

- [Keep users in the app Database](/docs/auth/configure#keep-users-in-the-app-database): keep users and sessions after a restart.
- [Sessions without a database](/docs/auth/configure#sessions-without-a-database): use social sign-in only, with no database.
- [Server API](/docs/auth/server-api): protect your routes so only signed-in users can use them.
