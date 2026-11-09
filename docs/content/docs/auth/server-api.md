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
| `isGitHubOrgMember` from `@vite-hub/auth` | Check that a GitHub token belongs to an active [organization member](#github-organization-membership). |
| `stateless` from `@vite-hub/auth/presets` | Keep sessions in encrypted cookies, [with no database](/docs/auth/configure#sessions-without-a-database). |
| `hubAuth` from `@vite-hub/auth/vite` | Add Auth discovery, the route, and generated server aliases. |
| `auth`, `getAuth`, `getAuthForRequest` from `@vite-hub/auth/server` | Use the Better Auth instance in server code. |
| Default export of `@vite-hub/auth/server` | The Auth route as a Fetchable, `{ fetch(request) }`. Mount it when you set `route: false`. |
| `handleAuth`, `handleAuthRequest`, `createAuthHandler` from `@vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `withAuth` from `@vite-hub/auth/server` | Run a handler only when a session exists. |
| `requireAuthAccessRoutes` from `@vite-hub/auth/server` | Guard selected access routes. |
| `withAuthorization` from `@vite-hub/auth/server` | Run a handler only after `true` or an `authorize` callback accepts the request. Never redirects to sign-in. |
| `requireAuth`, `requireAuthorization`, `getAuthorization` from `@vite-hub/auth/server` | Guard an H3 2 route with middleware, then read the checked session in the handler. |
| `useUserSession`, `useSession`, `createAuthClient`, `loadAuthClient` from `@vite-hub/auth/vue` | Read session state and call Better Auth from Vue. Better Auth loads on first use. |
| `authenticated` from `@vite-hub/auth/agent` | Turn a Better Auth session into an Agent Invoker (who calls the Agent). |
| `agentAuth` from `@vite-hub/auth/agent` | The `auth` primitive that generated Agent routes pass to Capabilities. `agentAuth.user(actor)` reads the Auth user from `actor.meta.authUserId`, or returns `null`. `authenticated()` sets `authUserId` for a request with a session. Channel and anonymous Actors have none, unless your `invoker.resolve` adds it. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Handle missing sessions and provider failures by Auth error code. |

## Use it at runtime

ViteHub mounts the Auth route at `/api/auth/**`, so same-origin apps need no route file.

In Vue, `useUserSession()` gives you `user`, `session`, sign-in and sign-out actions, and the `loggedIn`, `pending`, and `ready` refs.

```ts [lib/auth-client.ts]
import { useUserSession } from '@vite-hub/auth/vue'

export const userSession = useUserSession()
```

For a custom `basePath` or Better Auth client plugins, import `createAuthClient` from the same entry. It loads Better Auth on the first call, so it adds nothing to a page that does not sign in. `loadAuthClient(client)` returns Better Auth's own client for members such as `$store`. Use the same `basePath` in the client and the Definition. In a Nuxt app below `app.baseURL`, the default client uses that path, such as `/app/api/auth`. A custom client must include it in `basePath`.

Better Auth loads on the first Auth request, the first request an access route matches, or the first Console request with `console: { auth: "app" }`. A separate `console.auth` Definition still loads it at startup. Importing `@vite-hub/auth/server` also loads it, so import it in routes, not in a Nitro plugin or global middleware. A cold start then does not compile it.

Server code can read the Auth instance or require a session.

```ts [server/api/me.get.ts]
import { defineEventHandler, getRequestHeaders } from 'h3'
import { auth } from '@vite-hub/auth/server'

export default defineEventHandler(async (event) => {
  const headers = new Headers(getRequestHeaders(event))

  return auth.api.getSession({ headers })
})
```

To protect a route, wrap its handler. The guard checks the request, and your handler runs only if the check passes, with the checked `authorization`. You write no `if`, so a forgotten one cannot run the protected action.

```ts [server/api/profile.get.ts]
import { defineEventHandler } from 'h3'
import { withAuth } from '@vite-hub/auth/server'

export default defineEventHandler(withAuth((event, { user }) => ({ id: user.id })))
```

On H3 2, you can put the check in route middleware. `requireAuth()` rejects like `withAuth()`, and `requireAuthorization(authorize)` like `withAuthorization()`. When the check passes, the middleware calls `next()`, and the handler reads `authorization` with `getAuthorization(event)`.

```ts [server/app.ts] fragment
import { getAuthorization, requireAuth, requireAuthorization } from '@vite-hub/auth/server'
import { H3 } from 'h3'

export const app = new H3()
  .get('/me', event => ({ id: getAuthorization(event).user.id }), {
    middleware: [requireAuth()],
  })
  .delete('/posts/:id', event => deletePost(event), {
    middleware: [requireAuthorization(({ user }) => user.role === 'admin')],
  })
```

`getAuthorization(event)` reads only what the Auth middleware attached to the event, not `event.context`. Without the middleware, it throws `AUTH_R0017`, so the handler never runs unchecked.

## Server helpers

| Helper | Description |
| --- | --- |
| `auth` | Proxy to the discovered Better Auth instance. |
| `getAuth(runtimeOptions?)` | Returns the discovered Better Auth instance. |
| `getAuthForRequest(request, runtimeOptions?, event?)` | Returns a request-aware Better Auth instance. |
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. `input` is a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 2 event in a ViteHub app. Auth reads the client address and the Cloudflare bindings from the Standard Context of the Request. A Request that Nitro did not create gets one that reads srvx `ip` and `runtime.cloudflare`. |
| `handleAuthRequest(definition, input, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `toAuthRequest(input)` | Returns a Web `Request` itself, or `event['~standard'].req` of a request event. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a handler called as `handler(request, { clientAddress }?)`. Manual hosts pass the peer address for rate limiting and session IPs. |
| `createAuthAccessHandler(routes, definition?)` | Creates a handler that matches route metadata, checks the session, and runs every matching authorization rule. |
| `withAuth(handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when a session exists, else an unauthorized or sign-in response. |
| `withAuthorization(authorize, handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when allowed. Else it returns JSON `401` without a session, `403` when `authorize` returns `false`, or the callback's `Response`. |
| `withAnonymousAuthorization(authorize, handler, definition?)` | Like `withAuthorization()`, but a signed-out caller also reaches `authorize`, with `session` and `user` set to `null`. `false` returns JSON `401` for a signed-out caller and `403` for a signed-in one. |
| `requireAuth(definition?)` | Returns `(event, next)` route middleware for H3 2. Calls `next()` when a session exists, else responds like `withAuth()`. |
| `requireAuthorization(authorize, definition?)` | Returns `(event, next)` route middleware for H3 2. Calls `next()` when allowed, else responds like `withAuthorization()`. |
| `getAuthorization(event)` | Returns the `authorization` that `requireAuth()` or `requireAuthorization()` attached to the event. Throws `AUTH_R0017` when no Auth middleware accepted it. |

`auth`, `getAuth()`, `getAuthForRequest()`, and `assertAuthOrigin()` return an instance typed from your Auth Definition, with its plugins' endpoints and fields. The Vite plugin registers the type of `server/auth.ts` in `.vitehub/types/auth.d.ts`. So with the `admin()` plugin, `getAuthForRequest(event.req).api.listUsers` type-checks without a cast. For another definition, `getAuthForDefinition(definition)` infers the type, and `AuthFor<typeof definition>` from `@vite-hub/auth` names it.

`authorization` is a frozen `{ request, session, user }` object. Only the guard or middleware creates it, so a caller cannot pass its own.

### GitHub organization membership

`isGitHubOrgMember(accessToken, org, options?)` returns `true` only when GitHub says the token's user is an active member of `org`. The token needs the `read:org` scope. A pending invitation, a non-2xx response, a network error, or a timeout returns `false`, so a failed check never lets a user in. It uses only `fetch` and Web Crypto, so it runs on Node, Workers, and other hosts.

| Option | Default | Use |
| --- | --- | --- |
| `cacheMs` | No cache | Keep a successful check this many milliseconds per token and organization. Failed checks are never kept. Cache keys are SHA-256 digests, not tokens, and expired keys are removed. |
| `timeoutMs` | `5000` | Stop the GitHub request after this many milliseconds. |

```ts [server/utils/members.ts]
import { isGitHubOrgMember } from '@vite-hub/auth'

export const isTeamMember = (token: string | null | undefined) => isGitHubOrgMember(token, 'acme', { cacheMs: 300_000 })
```

The cache is in memory, so each Worker isolate or server process has its own. Inline Console Auth with `org` runs the same check at sign-in, without a cache.

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

The callback receives the signed-in `user`, `session`, and request. ViteHub defines no admin role, so check your own roles or permissions here.

The same callback protects [Blob serve routes](/docs/blob/configure#protect-served-objects) and [Collections](/docs/source/server-api#protect-a-collection). Their generated routes wrap the read with `withAuthorization(authorize, handler)`. Unlike `withAuth()`, it never redirects to sign-in, so image and fetch requests get a status code.

Generated access middleware loads `createAuthAccessHandler(routes, definition?)` on the first request that an access route matches. Manual hosts can use it with a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 2 event in a ViteHub app.

- Pass `{ route, method?, authorize?: true }` entries in the order of the Definition's `access.routes`.
- A route ending in `/**` matches its base path and everything below. Other routes match only that path.
- All matching rules apply. `authorize: true` needs the matching runtime callback.
- Requests that match nothing do not load the Auth Definition or session.

`requireAuthAccessRoutes(input, routeIndexes, definition, requiredAuthorizeRouteIndexes, { redirectToSignIn: false })` returns `401` to a signed-out browser instead of redirecting to provider sign-in. Use it when the host shows its own sign-in page and starts provider sign-in on a click. By default, it keeps the `access.signIn` redirect.

[Console](/docs/development/console#protect-the-console-route) covers its page, RPC endpoint, provider status route, and disabled behavior. The Console can use its own Console Auth instead of these access routes. On Cloudflare Workers, the [Cloudflare Access provider](/docs/development/console#protect-the-console-route) protects it without a Better Auth database.
