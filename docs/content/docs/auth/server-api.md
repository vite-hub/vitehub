---
title: Auth server API
description: Read sessions, call Better Auth, and guard routes from server and Vue code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `createDatabaseAuthEventStore` from `@vite-hub/auth` | Create the opt-in SQLite or D1 [event log](/docs/auth/events). |
| `getAuthEvents`, `listAuthEvents`, `aggregateAuthEvents` from `@vite-hub/auth/server` | Read events and daily counts from server code. |
| `defineAuth` from `@vite-hub/auth` | Declare the Primary Auth Definition. |
| `isGitHubOrgMember` from `@vite-hub/auth` | Check that a GitHub access token belongs to an active member of an organization. See [GitHub organization membership](#github-organization-membership). |
| `stateless` from `@vite-hub/auth/presets` | Keep sessions in encrypted cookies, with no database. See [Sessions without a database](/docs/auth/configure#sessions-without-a-database). |
| `hubAuth` from `@vite-hub/auth/vite` | Register Auth discovery, route exposure, and generated server aliases. |
| `useAuth`, `auth`, `getAuth` from `@vite-hub/auth/server` | Access the Better Auth instance from server code. |
| `handleAuth`, `handleAuthRequest`, `createAuthHandler` from `@vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `withAuth` from `@vite-hub/auth/server` | Run a server handler only with an Auth Session. |
| `requireAuthAccessRoutes` from `@vite-hub/auth/server` | Guard selected configured access routes. |
| `withAuthorization` from `@vite-hub/auth/server` | Run a resource handler only after `true` or an `authorize` callback accepts the request. Never redirects to sign-in. |
| `requireAuth`, `requireAuthorization` from `@vite-hub/auth/server` | Check the session inside a handler. They return the checked session or throw an HTTP error. |
| `useUserSession`, `useSession`, `createAuthClient`, `loadAuthClient` from `@vite-hub/auth/vue` | Read session state and call Better Auth from Vue. The client loads Better Auth on first use. |
| `authenticated` from `@vite-hub/auth/agent` | Map a Better Auth session into an Agent Invoker. |
| `agentAuth` from `@vite-hub/auth/agent` | The `auth` primitive generated Agent routes pass to Capabilities. `agentAuth.user(actor)` reads the Auth user behind an Actor from `actor.meta.authUserId`, or returns `null`. `authenticated()` sets `authUserId` for a request with a session. A Channel Actor or an anonymous Actor has none, unless your `invoker.resolve` adds it. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Handle missing authentication and provider failures by stable Auth code. |

## Use it at runtime

The default Auth route is `/api/auth/**`. ViteHub mounts it automatically, so same-origin apps do not need a manual route file.

Vue apps can use the same-origin ViteHub Auth client and normalized session state directly. `useUserSession()` exposes `user`, `session`, sign-in and sign-out actions, and `loggedIn`, `pending`, and `ready` refs.

```ts [lib/auth-client.ts]
import { useUserSession } from '@vite-hub/auth/vue'

export const userSession = useUserSession()
```

Import `createAuthClient` from the same entry when you use a custom `basePath` or Better Auth client plugins. The client loads Better Auth the first time you call it, so creating one up front adds nothing to a page that does not sign in. `loadAuthClient(client)` returns Better Auth's own client for members such as `$store`. Pass the same `basePath` to the client and the Definition. In a Nuxt app below `app.baseURL`, the default client uses that path, such as `/app/api/auth`; a custom client must include it in `basePath`.

App Auth loads Better Auth with the first Auth request, the first request that an access route matches, or the first Console request with `console: { auth: "app" }`. An independent `console.auth` Definition still loads Better Auth at startup. Your code loads it when it imports `@vite-hub/auth/server`. Import it in routes, not in a Nitro plugin or global middleware, so a cold start does not compile it.

Server code reads the Better Auth instance of a request with `useAuth(event)`.

```ts [server/api/session.get.ts]
import { useAuth } from '@vite-hub/auth/server'
import { defineHandler } from 'h3'
import type {} from '@vite-hub/runtime/h3'

export default defineHandler(event => useAuth(event).api.getSession({ headers: event.req.headers }))
```

The instance has the endpoints of your Auth Definition's plugins, without a cast. With `admin()` in `server/auth.ts`, this type-checks:

```ts [server/api/users.get.ts] fragment
import { requireAuthorization, useAuth } from '@vite-hub/auth/server'
import { defineHandler } from 'h3'

export default defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === 'admin')
  return useAuth(event).api.listUsers({ query: { limit: 20 }, headers: event.req.headers })
})
```

To protect a route, wrap its handler. The guard checks the request first. Your handler runs only when the check passes, and it receives the checked `authorization`. You do not branch on the check result yourself, so a missing `if` cannot run the protected action.

```ts [server/api/profile.get.ts]
import { defineEventHandler } from 'h3'
import { withAuth } from '@vite-hub/auth/server'

export default defineEventHandler(withAuth((event, { user }) => ({ id: user.id })))
```

To check inside the handler, call `requireAuth(event)`. It returns the checked `authorization`, or throws an H3 `HTTPError` that rejects like `withAuth()`: `401`, or the `access.signIn` redirect for an HTML request. `requireAuthorization(event, authorize)` rejects like `withAuthorization()`: `401` without a session, `403` when `authorize` returns `false`, or an HTTP error from the callback's `Response`. The rest of the handler runs only after the check passes.

The inline guards use H3's JSON error format. They keep the response status and headers, except `content-length`, which changes with the body. JSON object fields stay at the top level, and other JSON values become `data`. JSON media types, such as `application/problem+json`, stay unchanged. Text becomes `message` with a JSON content type. Use `withAuthorization()` when the response body must stay unchanged.

```ts [server/api/me.get.ts]
import { requireAuth } from '@vite-hub/auth/server'
import { defineHandler } from 'h3'
import type {} from '@vite-hub/runtime/h3'

export default defineHandler(async (event) => {
  const { user } = await requireAuth(event)
  return { id: user.id }
})
```

## Server helpers

| Helper | Description |
| --- | --- |
| `auth` | Proxy to the discovered Better Auth instance. |
| `getAuth(runtimeOptions?)` | Returns the discovered Better Auth instance. |
| `useAuth(event)` | Returns the Better Auth instance of the app's Auth Definition for a request event or a Web `Request`. |
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. `input` is a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 2 event in a ViteHub app. |
| `handleAuthRequest(definition, input, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `toAuthRequest(input)` | Returns a Web `Request` itself, or `event['~standard'].req` of a request event. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a handler called as `handler(request, { clientAddress }?)`. Manual hosts pass their peer address for rate limiting and session IPs. |
| `createAuthAccessHandler(routes, definition?)` | Creates a handler that matches discovered route metadata, then authenticates and runs every matching authorization rule. |
| `withAuth(handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when a session exists. Otherwise it returns an unauthorized or sign-in response. |
| `withAuthorization(authorize, handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when allowed. Otherwise it returns JSON `401` without a session, `403` when `authorize` returns `false`, or the callback's `Response`. |
| `withAnonymousAuthorization(authorize, handler, definition?)` | Like `withAuthorization()`, but a signed-out caller also reaches `authorize`, with `session` and `user` set to `null`. `false` returns JSON `401` for a signed-out caller and `403` for a signed-in one. |
| `requireAuth(event, definition?)` | Returns the checked `authorization` when a session exists. Otherwise it throws an `HTTPError` with the status and headers of the `withAuth()` response. |
| `requireAuthorization(event, authorize, definition?)` | Returns the checked `authorization` when allowed. Otherwise it throws an `HTTPError` with the status and headers of the `withAuthorization()` response. |

`useAuth()`, `auth`, `getAuth()`, and `assertAuthOrigin()` return the instance typed from your Auth Definition, with the endpoints and fields of its plugins. The Vite plugin registers the type of `server/auth.ts` in `.vitehub/types/auth.d.ts`, so `useAuth(event).api.listUsers` type-checks when the definition uses the `admin()` plugin, without a cast. For another definition, `getAuthForDefinition(definition)` infers the type from its argument, and `AuthFor<typeof definition>` from `@vite-hub/auth` names it.

The `authorization` argument and the `requireAuth()` result are a frozen `{ request, session, user }` object. Only the guards create it. A caller cannot pass its own value to the returned handler.

### GitHub organization membership

`isGitHubOrgMember(accessToken, org, options?)` returns `true` only when GitHub says the token's user is an active member of `org`. The token needs the `read:org` scope. A pending invitation, a non-2xx response, a network error, or a timeout returns `false`, so a failed check never admits a user. It uses only `fetch` and Web Crypto, so it runs on Node, Workers, and the other hosts.

| Option | Default | Use |
| --- | --- | --- |
| `cacheMs` | No cache | Keep a successful check for this many milliseconds per token and organization. A failed check is never kept. The cache keys are SHA-256 digests, not tokens, and expired keys are removed. |
| `timeoutMs` | `5000` | Give up on the GitHub request after this many milliseconds. |

```ts [server/utils/members.ts]
import { isGitHubOrgMember } from '@vite-hub/auth'

export const isTeamMember = (token: string | null | undefined) => isGitHubOrgMember(token, 'acme', { cacheMs: 300_000 })
```

The cache is in memory, so each Worker isolate or server process has its own. Inline Console Auth with `org` uses the same check at sign-in, without a cache.

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
    ],
  },
})
```

The callback receives the authenticated `user`, `session`, and request. ViteHub does not define an admin role. Map your own role or permission model here.

The same callback signature protects [Blob serve routes](/docs/blob/configure#protect-served-objects) and [Collections](/docs/source/server-api#protect-a-collection). Their generated routes wrap the protected read with `withAuthorization(authorize, handler)`. Unlike `withAuth()`, it does not start a sign-in redirect, so image and fetch requests receive a status code.

Generated access middleware loads `createAuthAccessHandler(routes, definition?)` on the first request that an access route matches. Manual hosts can use it with a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 2 event in a ViteHub app. Pass `{ route, method?, authorize?: true }` metadata in the same order as the Definition's `access.routes`. A route ending in `/**` matches its base path and descendants. Exact routes match only that path. All matching rules apply, and `authorize: true` requires the corresponding runtime callback. Unmatched requests do not load the Auth Definition or session.

`requireAuthAccessRoutes(input, routeIndexes, definition, requiredAuthorizeRouteIndexes, { redirectToSignIn: false })` returns `401` for an unauthenticated browser request instead of starting the configured provider sign-in redirect. Use it when the host shows its own sign-in page and starts provider sign-in after an explicit action. By default, it keeps the `access.signIn` redirect.

Read [Console](/docs/development/console#protect-the-console-route) for its page, RPC endpoint, provider status route, and disabled behavior. The Console can also use its own Console Auth instead of these access routes. On Cloudflare Workers, the [Cloudflare Access provider](/docs/development/console#protect-the-console-route) protects the Console without a Better Auth database.
