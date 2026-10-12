---
title: Create your first Auth session
description: Create an email-and-password user and verify their session with a saved cookie.
navigation.title: Tutorial
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Create a user with an email and password, then read their session using the cookie returned by sign-up. ViteHub discovers your Auth Definition; Better Auth handles the sign-up and session endpoints.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. This example uses an in-memory store, so restarting the server removes its users and sessions. Add a [database adapter](/docs/auth/configure#storage-placement-metadata) before using this setup in production.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Auth and Better Auth, then register discovery in your existing Vite config. Keep the app's other plugins.

```bash [commands/install]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth h3
pnpm add -D vite
```

Register the Auth integration:

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

`emailAndPassword.enabled` turns on the endpoints used below. You do not need to write sign-up or session routes yourself.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

ViteHub discovers the definition and mounts Better Auth at `/api/auth/**`.

::

::tutorial-step{title="Create and verify one session"}
## Create and verify one session

Start the dev server. Sign up with an email and password, saving the session
cookie for the second request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

`-c cookies.txt` saves the response cookie in a local file. The password below is example data; use a different password for a real account.

```bash [commands/sign-up]
curl -i -c cookies.txt -X POST http://localhost:5173/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

A successful response is `200` and includes a user, a session, and a
`set-cookie` header. Read the session back with the saved cookie:

```bash [commands/session]
curl -i -b cookies.txt http://localhost:5173/api/auth/get-session
```

The JSON response includes the signed-in user and session expiry. The default
store is for discovery and local checks, not durable production sessions. Read
[Storage placement](/docs/auth/configure#storage-placement-metadata) before
adding a database adapter, and [Server API](/docs/auth/server-api) for route
guards.
::
