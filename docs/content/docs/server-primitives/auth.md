---
title: Auth
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 3
icon: i-lucide-shield-check
---

Auth is the server primitive for application user identity and sessions. ViteHub owns the Auth Definition, Auth Route Exposure, storage placement metadata, and server runtime helpers. Storage placement metadata is inspectable configuration; it does not create Better Auth storage adapters.

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
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes guarded by generated Auth access middleware. Each entry is a route string or `{ method, route }`. |
| `access.signIn` | `{ provider: string, callbackURL?: string, errorCallbackURL?: string, requestSignUp?: boolean, scopes?: string[] }` | none | Redirect behavior for HTML requests rejected by `requireAuth()`. |
| `runtime` | `AuthRuntimeConfiguration` | none | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, and `secrets`. |

`baseURL`, `secret`, and `secrets` are runtime-only. Put them in the Definition callback or `runtime`, not as static top-level fields. Concrete Better Auth `database` and `secondaryStorage` adapters are also runtime values; return them from the callback or `runtime` when Auth needs persistent storage.

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

## Storage placement metadata

The `database` and `secondaryStorage` fields describe intended ViteHub primitive placement. ViteHub removes these metadata values before it calls `betterAuth()`, so they do not connect Better Auth to `@vite-hub/database` or `@vite-hub/kv`.

Omitting `database`, or setting it to `true`, selects Default Database metadata. Use a named reference when inspection should record an explicit target.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: true,
})
```

Set `dedicated: true` when the metadata should record that the Named Database is dedicated to Auth.

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
- Use [Database](/docs/server-primitives/database) and [KV](/docs/server-primitives/kv) as application primitives; Auth placement metadata does not wire them into Better Auth.
- Learn shared identity boundaries in [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers).
