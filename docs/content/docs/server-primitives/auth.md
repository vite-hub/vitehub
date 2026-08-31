---
title: Auth
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 3
navigation.group: Application
icon: i-lucide-shield-check
---

Use Auth to add Better Auth sessions and server-side identity checks to a ViteHub app. ViteHub discovers one Auth Definition, mounts its route, and provides server helpers. Better Auth still provides the sign-in UI, client plugins, and provider-specific behavior.

The `database` and `secondaryStorage` fields record where Auth data belongs. They don't create Better Auth storage adapters. Supply those adapters in the runtime configuration when you need persistent storage.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth
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
| `getViteHubErrorShape` from `@vite-hub/runtime` | Handle missing authentication and provider failures by stable Auth code. |
| `hubAuth` from `@vite-hub/auth/vite` | Register Auth discovery, route exposure, and generated server aliases. |

Create one Primary Auth Definition. ViteHub discovers `server/auth.ts` or `server.auth.ts`.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
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
| `database` | `AuthDatabaseConfiguration` | Default Database metadata | Records intended Default or Named Database placement for inspection. Use `true` or `{ name, dedicated? }`. It does not create a Better Auth database adapter. |
| `secondaryStorage` | `AuthSecondaryStorageConfiguration` | disabled | Records intended Default or named KV Store placement for inspection. Use `true` or `{ store }`. It does not create a Better Auth secondary storage adapter. |
| `basePath` | `string` | `/api/auth` | Sets the Auth Base Path. |
| `route` | `false` | enabled | Disables automatic Auth Route Exposure when set to `false`. |
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes guarded by generated Auth access middleware. Route objects accept `method`, `route`, and an `authorize` callback. |
| `access.signIn` | `{ provider: string, callbackURL?: string, errorCallbackURL?: string, requestSignUp?: boolean, scopes?: string[] }` | none | Redirect behavior for HTML requests rejected by `requireAuth()`. |
| `runtime` | `AuthRuntimeConfiguration` | none | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, and `secrets`. |

`baseURL`, `secret`, and `secrets` are runtime-only. Put them in the Definition callback or `runtime`, not as static top-level fields. Concrete Better Auth `database` and `secondaryStorage` adapters are also runtime values; return them from the callback or `runtime` when Auth needs persistent storage.

## Use it at runtime

The default Auth route is `/api/auth/**`. ViteHub mounts it automatically, so same-origin apps don't need a manual route file.

Vue apps can use the same-origin ViteHub Auth client and normalized session state directly.

```ts [lib/auth-client.ts]
import { useUserSession } from '@vite-hub/auth/vue'

export const userSession = useUserSession()
```

Import `createAuthClient` from the same entry when a custom base path or Better Auth client plugins are required.

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

### Authorize access routes

Add `authorize` when a session alone is not enough. ViteHub calls it only after authentication and returns `403` when it returns `false`. The callback can return a `Response` for a custom rejection. Returning `true` allows the request.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  access: {
    routes: [
      {
        route: '/_vitehub/**',
        authorize: ({ user }) => user.isAdmin === true,
      },
      {
        route: '/api/_vitehub/console/**',
        authorize: ({ user }) => user.isAdmin === true,
      },
    ],
  },
})
```

The callback receives the authenticated `user`, `session`, and request. ViteHub does not define an admin role. The host maps its own role or permission model here.

Read [Console](/docs/development/console#protect-both-route-groups) for its page and API routes, plus the behavior when Console is disabled.

## Storage placement metadata

The `database` and `secondaryStorage` fields describe intended ViteHub primitive placement. ViteHub removes these metadata values before it calls `betterAuth()`, so they do not connect Better Auth to `@vite-hub/database` or `@vite-hub/kv`.

Omitting `database`, or setting it to `true`, selects Default Database metadata. Use a named reference when inspection needs to record the target.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: true,
})
```

Set `dedicated: true` to record that the Named Database is dedicated to Auth.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: { name: 'auth', dedicated: true },
})
```

Secondary Storage metadata is opt-in. Use `true` for the Default KV Store metadata or `{ store }` for a named target.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  secondaryStorage: { store: 'auth' },
})
```

To persist Better Auth data today, supply a concrete Better Auth database or secondary storage adapter from the Auth Definition callback or its `runtime` field. The placement metadata above does not substitute for that adapter.

## Vite Integration options

`hubAuth()` accepts `false` to disable Auth integration for a build. The Vite config key is `auth`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubAuth()],
  auth: false,
})
```

## Provider output

Auth generates the definition module, route handler, access middleware, and ambient types needed by the host integration. Application code uses `@vite-hub/auth/server` or Better Auth clients, not generated files.

Set `route: false` only when a host integration or manual route mounts the Auth handler itself.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```

## Connect Auth to Agents

Auth identifies application users and sessions. Agents receive Agent Invokers. Map trusted Auth state into an Agent Invoker instead of adding Auth to the Agent Definition.

Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) for the mental model and [Official capabilities](/docs/capabilities/official-capabilities) for agent-facing access patterns.

### Handle required authentication

`authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED` when no required Auth Session exists. HTTP adapters map that code to `401`; the error serializes its public message without its cause or stack.

```ts
import { ViteHubError } from '@vite-hub/runtime'

const error = new ViteHubError('AUTHENTICATION_REQUIRED', 'Sign in to use this Agent.')

console.log(error.toJSON())
```

When a default Better Auth request or session operation fails, the boundary throws the same shared error with code `AUTH_PROVIDER_OPERATION_FAILED` and safe operation details; raw provider diagnostics remain available only through `cause`. Existing ViteHub errors and structural `AbortError` objects keep their identity. Missing APIs, malformed responses, invalid Auth Definitions, invalid `authenticated()` configuration, and invalid custom callback results are programmer or provider-contract errors, so they continue to throw `TypeError` rather than authentication failures.

## Next steps

- Configure typed secrets with [Env](/docs/server-primitives/env).
- Protect the [ViteHub Console](/docs/development/console) before enabling it in production.
- Use [Database](/docs/server-primitives/database) and [KV](/docs/server-primitives/kv) as application primitives; Auth placement metadata does not wire them into Better Auth.
- Learn shared identity boundaries in [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers).
