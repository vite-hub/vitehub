---
title: Auth
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 3
navigation.group: Application
icon: i-lucide-shield-check
---

Auth adds Better Auth sessions and server-side identity checks to a ViteHub app. ViteHub discovers one Auth Definition, mounts its route, guards the routes you list, and provides server helpers. Better Auth still provides the sign-in UI, client plugins, storage adapters, and provider-specific behavior.

Use Auth when your application has users who sign in. Server Primitives and Agents work without it.

::tip
- **Auth** identifies the users of your application and their sessions. It answers "who sent this request?"
- **[Connections](/docs/server-primitives/connections)** hold OAuth grants for third-party accounts that your app calls, for example a Gmail account. They answer "which account does the app act for?"
- **[Env](/docs/server-primitives/env)** supplies the Auth secret and OAuth client credentials.
::

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

Start the Vite dev server. ViteHub mounts Better Auth at `/api/auth/**`, so `POST /api/auth/sign-up/email` creates a user and a session.

::

With the `vite-hub` package, enable Auth with `vitehub({ preset, auth: true })` and import from `vite-hub/auth` and its `server`, `agent`, and `vue` subpaths.

This default proves discovery and the session route. It is not durable storage. Supply a Better Auth database adapter before you rely on sessions across restarts or replicas. See [Storage placement metadata](#storage-placement-metadata).

## Public imports

| Import | Use |
| --- | --- |
| `defineAuth` from `@vite-hub/auth` | Declare the Primary Auth Definition. |
| `hubAuth` from `@vite-hub/auth/vite` | Register Auth discovery, route exposure, and generated server aliases. |
| `auth`, `getAuth`, `getAuthForRequest` from `@vite-hub/auth/server` | Access the Better Auth instance from server code. |
| `handleAuth`, `handleAuthRequest`, `createAuthHandler` from `@vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `requireAuth` from `@vite-hub/auth/server` | Guard server routes with an Auth Session. |
| `requireAuthAccessRoutes` from `@vite-hub/auth/server` | Guard selected configured access routes. |
| `authorizeRequest` from `@vite-hub/auth/server` | Authorize one resource request with `true` or an `authorize` callback. Never redirects to sign-in. |
| `useUserSession`, `useSession`, `createAuthClient` from `@vite-hub/auth/vue` | Read session state and call Better Auth from Vue. |
| `authenticated` from `@vite-hub/auth/agent` | Map a Better Auth session into an Agent Invoker. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Handle missing authentication and provider failures by stable Auth code. |

## Auth Definition

Create one Primary Auth Definition in `server/auth.ts` or `server.auth.ts`. ViteHub also accepts the `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs` extensions. More than one Definition fails the build.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: {
    enabled: true,
  },
})
```

`defineAuth()` accepts Better Auth server options at the top level, plus fields that ViteHub owns.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| Better Auth options | `AuthBetterAuthOptions` | Better Auth defaults | Passed to `betterAuth()` after ViteHub-owned fields are removed. |
| `database` | `true \| { name, dedicated? }` | Default Database metadata | Records the intended Default or Named Database for inspection. It does not create a Better Auth database adapter. |
| `secondaryStorage` | `true \| { store }` | Disabled | Records the intended Default or named KV Store for inspection. It does not create a Better Auth secondary storage adapter. |
| `basePath` | `string` | `/api/auth` | Sets the Auth Base Path. It must start with `/`. |
| `route` | `false` | Enabled | Disables automatic Auth route exposure. |
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes guarded by generated Auth access middleware. Use a route string, or an object with `route`, optional `method`, and optional `authorize`. |
| `access.signIn` | `{ provider, callbackURL?, errorCallbackURL?, requestSignUp?, scopes? }` | None | Redirect behavior for HTML requests that `requireAuth()` rejects. |
| `runtime` | Options object or `(context) => options` | None | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, `secrets`, and storage adapters. |

`baseURL`, `secret`, and `secrets` are runtime-only. Return them from a Definition callback or put them under `runtime`, not as static top-level fields. `access.routes` must be static so the Vite Integration can register middleware.

## Runtime options

Use a Definition callback or the `runtime` field when values depend on the request, Server Env, provider credentials, or request origin. Declare the secrets in [Env](/docs/server-primitives/env) first.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv(), hubAuth()],
  env: {
    server: {
      auth: {
        github: {
          clientId: env({ source: env.source('GITHUB_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GITHUB_CLIENT_SECRET') }),
        },
        secret: env({ secret: true, source: env.source('BETTER_AUTH_SECRET') }),
      },
    },
  },
})
```

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth(({ env, requestOrigin }) => ({
  appName: 'Acme',
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}))
```

| Callback input | Value |
| --- | --- |
| `env` | Typed Server Env when the Env Vite Integration is registered. `vitehub()` registers it by default. |
| `requestOrigin` | The origin of the current request. Same-origin apps do not need a separate auth URL variable. |
| `request` | The current request headers and URL, when a request exists. |

Without a `baseURL`, Auth uses `vitehub({ publicUrl })`, then the request origin. Each Auth request or route guard resolves the Definition and `runtime` callbacks once. A later request resolves fresh options.

## Providers

Better Auth is the only Auth provider. ViteHub does not replace its storage, OAuth providers, or client plugins.

| Concern | Owner |
| --- | --- |
| Sign-in methods, OAuth providers, plugins | Better Auth options in the Auth Definition. |
| User and session storage | A Better Auth database adapter that you return from the callback or `runtime`. |
| Route mounting | `hubAuth()` in development and a generated Nitro handler in builds. Manual hosts mount `#vitehub/auth/server`. |
| Roles and permissions | Your `authorize` callbacks. ViteHub defines no roles. |

## Use it at runtime

The default Auth route is `/api/auth/**`. ViteHub mounts it automatically, so same-origin apps do not need a manual route file.

Vue apps can use the same-origin ViteHub Auth client and normalized session state directly. `useUserSession()` exposes `user`, `session`, sign-in and sign-out actions, and `loggedIn`, `pending`, and `ready` refs.

```ts [lib/auth-client.ts]
import { useUserSession } from '@vite-hub/auth/vue'

export const userSession = useUserSession()
```

Import `createAuthClient` from the same entry when you use a custom `basePath` or Better Auth client plugins. Pass the same `basePath` to the client and the Definition.

Server code can read the discovered Auth instance or require a session for a request.

```ts [server/api/me.get.ts]
import { auth } from '@vite-hub/auth/server'

export default defineEventHandler(async (event) => {
  const headers = new Headers(getRequestHeaders(event))

  return auth.api.getSession({ headers })
})
```

## Server helpers

| Helper | Description |
| --- | --- |
| `auth` | Proxy to the discovered Better Auth instance. |
| `getAuth(runtimeOptions?)` | Returns the discovered Better Auth instance. |
| `getAuthForRequest(request, runtimeOptions?, event?)` | Returns a request-aware Better Auth instance. |
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. |
| `handleAuthRequest(definition, request, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a Better Auth handler from a Definition. |
| `requireAuth(input, definition?)` | Returns `undefined` when a session exists. Otherwise returns an unauthorized or sign-in response. |
| `authorizeRequest(input, authorize, definition?)` | Returns `undefined` when allowed, JSON `401` without a session, `403` when `authorize` returns `false`, or the callback's `Response`. |

### Authorize access routes

Add `authorize` when a session alone is not enough. ViteHub calls it only after authentication.

| `authorize` returns | Result |
| --- | --- |
| `true` | The request continues. |
| `false` | `403`. |
| A `Response` | That response, as-is. |

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

The callback receives the authenticated `user`, `session`, and request. ViteHub does not define an admin role. Map your own role or permission model here.

The same callback signature protects [Blob serve routes](/docs/server-primitives/blob#protect-served-objects) and [Collections](/docs/server-primitives/source#protect-a-collection). Their generated routes call `authorizeRequest(input, authorize)`. Unlike `requireAuth()`, it does not start a sign-in redirect, so image and fetch requests receive a status code.

`requireAuthAccessRoutes(input, routeIndexes, definition, requiredAuthorizeRouteIndexes, { redirectToSignIn: false })` returns `401` for an unauthenticated browser request instead of starting the configured provider sign-in redirect. Use it when the host shows its own sign-in page and starts provider sign-in after an explicit action. By default, it keeps the `access.signIn` redirect.

Read [Console](/docs/development/console#protect-the-console-route) for its page, RPC endpoint, provider status route, and disabled behavior. The Console can also use its own Console Auth instead of these access routes. On Cloudflare Workers, the [Cloudflare Access provider](/docs/development/console#protect-the-console-route) protects the Console without a Better Auth database.

## Storage placement metadata

The `database` and `secondaryStorage` fields describe intended ViteHub primitive placement for inspection. ViteHub removes these values before it calls `betterAuth()`. They do not connect Better Auth to `@vite-hub/database` or `@vite-hub/kv`.

| Value | Records |
| --- | --- |
| `database` omitted or `true` | The Default Database. |
| `database: { name: 'auth' }` | The Named Database `auth`. |
| `database: { name: 'auth', dedicated: true }` | The Named Database `auth`, dedicated to Auth. |
| `secondaryStorage` omitted | No secondary storage. |
| `secondaryStorage: true` | The Default KV Store. |
| `secondaryStorage: { store: 'auth' }` | The named KV Store `auth`. |

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: { name: 'auth', dedicated: true },
  secondaryStorage: { store: 'auth' },
})
```

To persist Better Auth data, return a concrete Better Auth `database` or `secondaryStorage` adapter from the Definition callback or its `runtime` field. The placement metadata does not substitute for that adapter.

## Vite Integration options

`hubAuth()` accepts `false` to disable Auth integration. The Vite config key `auth` overrides the plugin argument.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubAuth()],
  auth: false,
})
```

## Provider output

Auth generates the Definition module, route handler, access middleware, and ambient types (`.vitehub/types/auth.d.ts`) that the host integration needs. Application code uses `@vite-hub/auth/server` or Better Auth clients, not generated files.

Set `route: false` only when a host integration or a manual route mounts the Auth handler itself.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```

## Production checks

- Supply a strong Better Auth secret from Server Env at request time. Never put it in Public Env, client code, Agent input, logs, or traces.
- Set a request-aware `baseURL`, use `requestOrigin`, or set `vitehub({ publicUrl })`, so callback and cookie origins match the deployed host.
- Configure a concrete Better Auth database adapter and its migrations.
- Protect application and Console pages and APIs explicitly. A session proves identity. Your `authorize` callbacks define roles and permissions.
- Keep automatic `/api/auth/**` exposure unless the host mounts the handler itself. Use the same `basePath` on the server and the client.

## Connect Auth to Agents

Auth identifies application users and sessions. Agents receive Agent Invokers. Map trusted Auth state into an Agent Invoker with `authenticated()` instead of adding Auth to the Agent Definition.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { authenticated } from '@vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
})
```

By default, `authenticated()` reads the same-app Better Auth session and maps the Auth User to an Agent Invoker with `kind: "authUser"`. Use the [Access](/docs/capabilities/access) Capability for decisions based on invoker identity. Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) for the mental model.

### Handle required authentication

`authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED` when a required Auth Session does not exist. HTTP adapters map that code to `401`. The error serializes its public message without its cause or stack.

```ts
import { ViteHubError } from '@vite-hub/runtime'

const error = new ViteHubError('AUTHENTICATION_REQUIRED', 'Sign in to use this Agent.')

console.log(error.toJSON())
```

| Code | When |
| --- | --- |
| `AUTHENTICATION_REQUIRED` | `authenticated()` requires a session and none exists. |
| `AUTH_PROVIDER_OPERATION_FAILED` | A default Better Auth request or session operation fails. Safe operation details are included. Raw provider diagnostics stay in `cause`. |
| `AUTH_C####`, `AUTH_B####`, `AUTH_R####` | Missing APIs, malformed responses, invalid Auth Definitions, invalid `authenticated()` configuration, and invalid custom callback results. |

Existing ViteHub errors and structural `AbortError` objects keep their identity.

## Next steps

- Configure typed secrets with [Env](/docs/server-primitives/env).
- Protect the [ViteHub Console](/docs/development/console) before you enable it in production.
- Call third-party APIs for connected accounts with [Connections](/docs/server-primitives/connections).
- Use [Database](/docs/server-primitives/database) and [KV](/docs/server-primitives/kv) as application primitives. Auth placement metadata does not wire them into Better Auth.
- Learn shared identity boundaries in [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers).
