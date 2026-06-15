---
title: Auth
description: Configure Better Auth on the server and use Better Auth clients from application code.
navigation.order: 4
icon: i-lucide-shield-check
---

Auth is the primitive for application user identity and sessions. ViteHub owns the server-side Auth Definition, route exposure, storage placement, and runtime resolution. Your application owns the client UI.

Use Better Auth's client libraries from the browser. ViteHub does not ship framework-specific auth hooks or login components.

## Install Auth

Examples on this page assume pnpm, Node 24 or newer, and a Vite server app.

```bash [Terminal]
pnpm add @vite-hub/auth better-auth
```

Register the Vite Integration.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

## Define Auth

Create one Auth Definition for the app.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  database: true,
})
```

`server/auth.ts` is the canonical Auth Definition Location. You can use `server.auth.ts` instead when a flat server file fits the project better.

Better Auth options stay top-level. ViteHub reserves `database`, `secondaryStorage`, `basePath`, and `route` for package-owned wiring.

## Expose the Auth route

The Canonical Auth Route Path is `/api/auth/**`. In local Vite development, the Vite Integration exposes that route by default.

When your host needs an explicit server route, or when you set `route: false`, mount the Auth handler yourself.

```ts [server/api/auth/[...].ts]
import { auth } from '@vite-hub/auth/server'

export default auth.handler
```

If runtime auth values depend on the current request or server environment, derive them at the mount point.

```ts [server/api/auth/[...].ts]
import { handleAuthRequest } from '@vite-hub/auth/server'
import authDefinition from '../../auth'

export default async function handleAuth(request: Request) {
  return handleAuthRequest(authDefinition, request, {
    secret: process.env.BETTER_AUTH_SECRET,
  })
}
```

Use Manual Auth Mount only when automatic Auth Route Exposure is unavailable or intentionally disabled.

## Use Better Auth on the client

Create the application client with Better Auth's own client package.

```ts [lib/auth-client.ts]
import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient()
```

The default client works when the app and Auth route share the same origin and the Auth Base Path is `/api/auth`.

For React, Vue, Svelte, Solid, and other framework-specific clients, import from the Better Auth entrypoint for that framework. ViteHub's job is to expose the Auth server route; Better Auth owns client hooks, sign-in actions, session state, client plugins, and framework integration.

```ts [lib/auth-client.ts]
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient()
```

```tsx [components/user-menu.tsx]
import { authClient } from '../lib/auth-client'

export function UserMenu() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) return null

  if (!session) {
    return <a href="/sign-in">Sign in</a>
  }

  return (
    <button type="button" onClick={() => authClient.signOut()}>
      Sign out
    </button>
  )
}
```

Read Better Auth's [client documentation](https://www.better-auth.com/docs/concepts/client) for framework entrypoints, fetch options, client plugins, and error handling. Read Better Auth's [basic usage guide](https://better-auth.com/docs/basic-usage) for session examples.

## Customize the Auth Base Path

Set `basePath` when the app should expose Auth somewhere other than `/api/auth`.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  basePath: '/auth',
  database: true,
})
```

Pass the same path to the Better Auth client.

```ts [lib/auth-client.ts]
import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient({
  basePath: '/auth',
})
```

`basePath` is route metadata. Do not put `baseURL`, `secret`, or `secrets` in `defineAuth()`. Those values are resolved at runtime by the Auth Package.

Use `baseURL` in the client only when the browser talks to an Auth server on a different origin.

```ts [lib/auth-client.ts]
import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient({
  baseURL: 'https://api.example.com',
})
```

## Choose Auth storage

Auth Database Placement defaults to the selected application database when the project has a Default Database.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  database: true,
})
```

Use a named database when the app has multiple databases.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  database: { name: 'primary' },
})
```

A dedicated Auth database is explicit.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  database: { name: 'auth', dedicated: true },
})
```

Auth Secondary Storage is opt-in even when the KV Package is installed.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'My app',
  database: true,
  secondaryStorage: { store: 'auth' },
})
```

Storage placement is metadata in the current package layer. Runtime adapters are passed through `@vite-hub/auth/server` today and will be wired into the Database and KV packages in follow-up iterations.

## Keep Auth separate from Agent Invokers

An Auth Session identifies an Auth User. An Agent Invocation receives an Agent Invoker. Those are separate concepts.

Use the Authenticated Agent Helper when an Agent should derive its Agent Invoker from the current Auth Session.

```ts [server/support.agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { authenticated } from '@vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
})
```

`authenticated()` is opt-in at the Agent or Entry Surface boundary. Merely defining Auth does not make every Agent Invocation require Auth.

For the default same-app path, `authenticated()` reads the Better Auth session from the request and maps the Auth User to an Agent Invoker with `kind: 'authUser'`. Use its `id`, `kind`, `label`, and `meta` options for common identity shaping, or provide `source` or `map` when the Agent consumes JWTs, bearer tokens, OAuth/OIDC provider output, or product-specific identity.

Auth does not move into the Agent Package and Agent identity does not become login UI.
