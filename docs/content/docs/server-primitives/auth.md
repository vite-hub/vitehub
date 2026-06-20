---
title: Auth
description: Configure Better Auth server behavior, route exposure, storage placement, and session checks.
navigation.order: 3
icon: i-lucide-shield-check
---

Auth is the server primitive for application user identity and sessions. ViteHub owns the Auth Definition, Auth Route Exposure, Auth Database Placement, Auth Secondary Storage, and server runtime helpers.

Better Auth owns client packages, sign-in UI, session hooks, client plugins, and provider-specific client behavior. Use ViteHub to expose and configure the server route, then use Better Auth clients in the browser.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/auth better-auth
```

### Configure

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

### Start using it

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineAuth` from `@vite-hub/auth` | Declare the Primary Auth Definition. |
| `auth`, `getAuth`, `getAuthForRequest` from `@vite-hub/auth/server` | Access the Better Auth instance from server code. |
| `handleAuth`, `handleAuthRequest`, `createAuthHandler` from `@vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `requireAuth` from `@vite-hub/auth/server` | Guard server routes with an Auth Session. |
| `authenticated` from `@vite-hub/auth/agent` | Map a Better Auth session into an Agent Invoker. |
| `hubAuth` from `@vite-hub/auth/vite` | Register Auth discovery, route exposure, and generated server aliases. |

Create one Primary Auth Definition. ViteHub discovers `server/auth.ts` or `server.auth.ts`.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: true,
  emailAndPassword: {
    enabled: true,
  },
})
```

Better Auth-compatible options stay top-level. ViteHub reserves Auth fields such as `database`, `secondaryStorage`, `basePath`, `route`, `access`, and `runtime` for package-owned behavior.

## Auth Definition options

`defineAuth()` accepts Better Auth server options at the top level, plus ViteHub-owned Auth fields.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| Better Auth options | `AuthBetterAuthOptions` | Better Auth defaults | Passed through to `betterAuth()` after ViteHub-owned fields are removed. |
| `database` | `AuthDatabaseConfiguration` | selected Default Database | Places Auth tables in the selected application database or an explicit Named Database. Use `true` or `{ name, dedicated? }`. |
| `secondaryStorage` | `AuthSecondaryStorageConfiguration` | disabled | Uses the Default KV Store or a named KV Store for Better Auth secondary storage. Use `true` or `{ store }`. |
| `basePath` | `string` | `/api/auth` | Sets the Auth Base Path. |
| `route` | `false` | enabled | Disables automatic Auth Route Exposure when set to `false`. |
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes guarded by generated Auth access middleware. Each entry is a route string or `{ method, route }`. |
| `access.signIn` | `{ provider: string, callbackURL?: string, errorCallbackURL?: string, requestSignUp?: boolean, scopes?: string[] }` | none | Redirect behavior for HTML requests rejected by `requireAuth()`. |
| `runtime` | `AuthRuntimeConfiguration` | none | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, and `secrets`. |

`baseURL`, `secret`, and `secrets` are runtime-only. Put them in the Definition callback or `runtime`, not as static top-level fields.

## Use it at runtime

The Canonical Auth Route Path is `/api/auth/**`. Auth Route Exposure is enabled by default, so apps do not need to create a manual route file for the common same-origin case.

Use Better Auth's client package from browser code.

```ts [lib/auth-client.ts]
import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient()
```

Server code can read the discovered Auth instance or require a session for a request.

```ts [server/api/me.get.ts]
import { auth } from '@vite-hub/auth/server'

export default defineEventHandler(async (event) => {
  const headers = new Headers(getRequestHeaders(event))

  return auth.api.getSession({ headers })
})
```

## Runtime options

Use an Auth Definition callback or the `runtime` field when values depend on the current request, Server Env, provider credentials, or request origin.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth(({ env, requestOrigin }) => ({
  appName: 'Acme',
  baseURL: requestOrigin,
  runtime: {
    secret: env.auth.secret.unseal(),
  },
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}))
```

When `@vite-hub/env` is installed before Auth, the callback receives typed Server Env. `requestOrigin` lets same-origin apps avoid a separate auth URL variable.

## Server helpers

| Helper | Description |
| --- | --- |
| `auth` | Proxy to the discovered Better Auth instance. |
| `getAuth(runtimeOptions?)` | Returns the discovered Better Auth instance. |
| `getAuthForRequest(request, runtimeOptions?, event?)` | Returns a request-aware Better Auth instance. |
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. |
| `handleAuthRequest(definition, request, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a Better Auth handler from a Definition. |
| `requireAuth(input, definition?)` | Returns `undefined` when a session exists, otherwise returns an unauthorized or sign-in response. |

## Storage placement

Auth Database Placement defaults to the selected application database when the app has a Default Database.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: true,
})
```

Use a named database only when the app has multiple Named Databases and Auth must target one explicitly.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: { name: 'primary' },
})
```

Auth Secondary Storage is opt-in. Configure it when Better Auth plugin data, verification records, or session-adjacent state should use a KV Store.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  secondaryStorage: { store: 'auth' },
})
```

## Vite Integration options

`hubAuth()` accepts `false` to disable Auth integration for a build. The Vite config key is `auth`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubAuth()],
  auth: false,
})
```

## Provider output

Auth generates the discovered definition module, route handler, access middleware, and ambient types needed by the host integration. Application code should use `@vite-hub/auth/server` or Better Auth clients, not generated files.

Set `route: false` only when a host integration or manual route should mount the Auth handler itself.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```

## Connect it to Agents

Auth identifies application users and sessions. Agents consume Agent Invokers, so Auth-to-Agent behavior should map trusted Auth state into an Agent Invoker instead of making Auth part of the Agent Definition.

Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) for the mental model and [Official capabilities](/docs/capabilities/official-capabilities) for agent-facing access patterns.

## Next steps

- Configure typed secrets with [Env](/docs/server-primitives/env).
- Co-locate Auth tables through [Database](/docs/server-primitives/database).
- Learn shared identity boundaries in [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers).
