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
| `createDatabaseAuthEventStore` from `vite-hub/auth` | Create the opt-in SQLite or D1 [event log](/docs/auth/events). |
| `getAuthEvents`, `listAuthEvents`, `aggregateAuthEvents` from `vite-hub/auth/server` | Read events and daily counts from server code. |
| `defineAuth` from `vite-hub/auth` | Declare the Primary Auth Definition. |
| `isGitHubOrgMember` from `vite-hub/auth` | Check that a GitHub token belongs to an active [organization member](#github-organization-membership). |
| `stateless` from `vite-hub/auth/presets` | Keep sessions in encrypted cookies, [with no database](/docs/auth/configure#sessions-without-a-database). |
| `hubAuth` from `@vite-hub/auth/vite` | Add Auth discovery, the route, and generated server aliases. |
| `useAuth`, `auth`, `getAuth` from `vite-hub/auth/server` | Use the Better Auth instance in server code. |
| Default export of `vite-hub/auth/server` | The Auth route as a Fetchable, `{ fetch(request) }`. Mount it when you set `route: false`. |
| `handleAuth`, `createAuthHandler` from `vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `withAuth` from `vite-hub/auth/server` | Run a handler only when a session exists. |
| `withAuthorization` from `vite-hub/auth/server` | Run a handler only after `true` or an `authorize` callback accepts the request. Never redirects to sign-in. |
| `requireAuth`, `requireAuthorization` from `vite-hub/auth/server` | Check the session inside a handler. They return the checked session or throw an HTTP error. |
| `defineAbilities`, `deny`, `guest` from `vite-hub/auth/abilities` | Write the rules of `shared/abilities.ts`. See [Abilities](/docs/auth/abilities). |
| `requireAbility`, `can`, `AbilityError` from `vite-hub/auth/server` | Check a rule of `shared/abilities.ts` in server code. |
| `useAbility`, `AuthPermission` from `vite-hub/auth/vue` | Check a rule of `shared/abilities.ts` in Vue. `useAbility()` returns `can()`, `cannot()`, `authorize()`, and `ready`. |
| `useUserSession`, `useSession`, `createAuthClient`, `loadAuthClient` from `vite-hub/auth/vue` | Read session state and call Better Auth from Vue. Better Auth loads on first use. |
| `defineAuthClient` from `vite-hub/auth/vue` | Set the [client plugins](#client-plugins) of the default client in `auth.client.ts`. |
| `authenticated` from `vite-hub/auth/agent` | Turn a Better Auth session into an Agent Invoker (who calls the Agent). |
| `agentAuth` from `vite-hub/auth/agent` | The `auth` primitive that generated Agent routes pass to Capabilities. `agentAuth.user(actor)` reads the Auth user from `actor.meta.authUserId`, or returns `null`. `authenticated()` sets `authUserId` for a request with a session. Channel and anonymous Actors have none, unless your `invoker.resolve` adds it. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Handle missing sessions and provider failures by Auth error code. |

## Use it at runtime

ViteHub mounts the Auth route at `/api/auth/**`, so same-origin apps need no route file.

In Vue, `useUserSession()` gives you `user`, `session`, sign-in and sign-out actions, the `loggedIn`, `pending`, and `ready` refs, and the Better Auth `client`.

```ts [lib/auth-client.ts]
import { useUserSession } from 'vite-hub/auth/vue'

export const userSession = useUserSession()
```

All components share one session state, so a list of 100 rows that call `useUserSession()` makes one Better Auth subscription. `await refresh()` reads the session again, updates every component, and returns the session, or `null` without one. Calls at the same time share one read. On the server, `refresh()` returns the session that the server read for the request. `ready` is `true` after the first read, and stays `true` while a later read runs. In Nuxt, the composables start with the session that the server read, and the browser reads it again only when it can change, such as when the tab shows again or another tab signs out.

In Nuxt, `useUserSession()` and `useSession()` use the Definition's `basePath` below `app.baseURL`, such as `/app/auth` for `basePath: '/auth'` below `/app/`. In the browser, they follow a `NUXT_APP_BASE_URL` that you set at runtime.

In Nuxt, a client call during server rendering, such as `listSessions()` in `<script setup>` or `useAsyncData()`, calls the app in-process with the visitor's cookie. The page renders the data on the server, and a session cookie that Better Auth refreshes reaches the browser with the page. A client with its own `baseURL` or `fetchOptions.customFetchImpl` keeps them, so its server calls do not carry the visitor's cookie. Better Auth's origin check refuses a `POST` call during server rendering with `403`, so make calls that change data in the browser. A prerendered or cached page renders without the visitor's cookie, so its calls answer as signed out.

`signOut()` signs out with Better Auth and sets `user` and `session` to `null` at once, in every component. Pass `redirectTo` to open a page after the sign-out:

```vue [src/components/UserMenu.vue]
<script setup lang="ts">
import { useUserSession } from 'vite-hub/auth/vue'

const { loggedIn, user, signOut } = useUserSession()
</script>

<template>
  <button v-if="loggedIn" @click="signOut({ redirectTo: '/' })">
    Sign out {{ user?.name }}
  </button>
</template>
```

- Nuxt opens `redirectTo` with `navigateTo()`. A plain Vue app loads it with `location.assign()`.
- Without `redirectTo`, in Nuxt, a page with `definePageMeta({ auth: 'user' })` sends the visitor to its login page, as the page guard does. Other pages stay open.
- Better Auth gets the other options, such as `fetchOptions`, and `signOut()` returns its result. When the sign-out fails, the session and the page stay.
- When Better Auth sends the visitor to the provider's sign-out page, such as with OpenID Connect logout, `signOut()` opens no other page. Better Auth's `callbackURL` option sets the page after that.

### Client plugins

To use Better Auth client plugins, such as `adminClient()`, export their options from `app/auth.client.ts` in a Nuxt app, or from `auth.client.ts` in the Vite root. The default client, `useUserSession()`, `useAuthClient()`, and the Nuxt page guard then use one client with these plugins.

```ts [app/auth.client.ts]
import { adminClient } from 'better-auth/client/plugins'
import { defineAuthClient } from 'vite-hub/auth/vue'

export default defineAuthClient({
  plugins: [adminClient()],
})
```

```vue [app/pages/admin.vue]
<script setup lang="ts">
definePageMeta({ auth: 'user' })

const { client } = useUserSession()
const { data } = await client.admin.listUsers({ query: { limit: 10 } })
</script>
```

- `defineAuthClient()` takes the options of Better Auth's `createAuthClient()`. ViteHub sets `basePath`. In Nuxt, it is the `basePath` of the Auth Definition, below `app.baseURL`.
- The client imports the file together with Better Auth, on first use, not when the app starts.
- ViteHub writes the type of the file to `.vitehub/types/auth.d.ts`, so `client.admin` and the other plugin endpoints are typed. Restart the dev server after you add or remove the file.

For a second client, or a custom `basePath` outside Nuxt, import `createAuthClient` from the same entry. It loads Better Auth on the first call, so it adds nothing to a page that does not sign in. `loadAuthClient(client)` returns Better Auth's own client for members such as `$store`. Use the same `basePath` in the client and the Definition. A custom client must include the app base path in `basePath`, such as `/app/auth`.

The default client has the user and session fields of your Auth Definition. See [Typed user fields](#typed-user-fields).

Better Auth loads on the first Auth request, or the first request an access route matches. Importing `vite-hub/auth/server` also loads it, so import it in routes, not in a Nitro plugin or global middleware. A cold start then does not compile it.

Server code reads the Better Auth instance of a request with `useAuth(event)`.

```ts [server/api/session.get.ts]
import { useAuth } from 'vite-hub/auth/server'
import { defineHandler } from 'h3'

export default defineHandler(event => useAuth(event).api.getSession({ headers: event.req.headers }))
```

The instance has the endpoints of your Auth Definition's plugins, without a cast. With `admin()` in `server/auth.ts`, this type-checks:

```ts [server/api/users.get.ts] fragment
import { requireAuthorization, useAuth } from 'vite-hub/auth/server'
import { defineHandler } from 'h3'

export default defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === 'admin')
  return useAuth(event).api.listUsers({ query: { limit: 20 }, headers: event.req.headers })
})
```

To protect a route, wrap its handler. The guard checks the request, and your handler runs only if the check passes, with the checked `authorization`. You write no `if`, so a forgotten one cannot run the protected action.

```ts [server/api/profile.get.ts]
import { defineEventHandler } from 'h3'
import { withAuth } from 'vite-hub/auth/server'

export default defineEventHandler(withAuth((event, { user }) => ({ id: user.id })))
```

To check inside the handler, call `requireAuth(event)`. It returns the checked `authorization`, or throws an H3 `HTTPError` that rejects like `withAuth()`: `401`, or the `access.signIn` redirect for an HTML request. `requireAuthorization(event, authorize)` rejects like `withAuthorization()`: `401` without a session, `403` when `authorize` returns `false`, or an HTTP error from the callback's `Response`. The rest of the handler runs only after the check passes.

Every refusal of the guards has one JSON body in H3's error format, with a stable code in `data.code`: `SIGNED_OUT` for `401` and `FORBIDDEN` for `403`. See [Read a refusal](/docs/auth/limits-and-errors#read-a-refusal). For a `Response` from `authorize`, the inline guards also use H3's JSON error format. They keep the response status and headers, except `content-length`, which changes with the body. JSON object fields stay at the top level, and other JSON values become `data`. JSON media types, such as `application/problem+json`, stay unchanged. Text becomes `message` with a JSON content type. Use `withAuthorization()` when the response body must stay unchanged.

```ts [server/api/me.get.ts]
import { requireAuth } from 'vite-hub/auth/server'
import { defineHandler } from 'h3'

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
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. `input` is a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 2 event in a ViteHub app. Auth reads the client address and the Cloudflare bindings from the Standard Context of the Request. A Request that Nitro did not create gets one that reads srvx `ip` and `runtime.cloudflare`. |
| `handleAuthRequest(definition, input, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `toAuthRequest(input)` | Returns a Web `Request` itself, or `event['~standard'].req` of a request event. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a handler called as `handler(request, { clientAddress }?)`. Manual hosts pass the peer address for rate limiting and session IPs. |
| `createAuthAccessHandler(routes, definition?)` | Creates a handler that matches route metadata, checks the session, and runs every matching authorization rule. |
| `withAuth(handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when a session exists. Else it returns JSON `401` with the code `SIGNED_OUT`, or the sign-in redirect for an HTML request. |
| `withAuthorization(authorize, handler, definition?)` | Returns a handler that calls `handler(input, authorization)` when allowed. Else it returns JSON `401` (`SIGNED_OUT`) without a session, `403` (`FORBIDDEN`) when `authorize` returns `false`, or the callback's `Response`. |
| `withAnonymousAuthorization(authorize, handler, definition?)` | Like `withAuthorization()`, but a signed-out caller also reaches `authorize`, with `session` and `user` set to `null`. `false` returns JSON `401` (`SIGNED_OUT`) for a signed-out caller and `403` (`FORBIDDEN`) for a signed-in one. |
| `requireAuth(event, definition?)` | Returns the checked `authorization` when a session exists. Otherwise it throws an `HTTPError` with the status and headers of the `withAuth()` response. |
| `requireAuthorization(event, authorize, definition?)` | Returns the checked `authorization` when allowed. Otherwise it throws an `HTTPError` with the status and headers of the `withAuthorization()` response. |
| `requireAbility(event, name, ...args)` | Returns `authorization` when the [ability](/docs/auth/abilities) allows the caller. Else throws `AbilityError`, which H3 sends with status `401`, `403`, or the status of `deny()`, and `{ code, details }` in `data`. |
| `can(event, name, ...args)` | Returns `true` when the ability allows the caller, else `false`. |

`useAuth()`, `auth`, `getAuth()`, and `assertAuthOrigin()` return the instance typed from your Auth Definition, with the endpoints and fields of its plugins. The Vite plugin registers the type of `server/auth.ts` in `.vitehub/types/auth.d.ts`, so `useAuth(event).api.listUsers` type-checks when the definition uses the `admin()` plugin, without a cast. For another definition, `getAuthForDefinition(definition)` infers the type from its argument, and `AuthFor<typeof definition>` from `vite-hub/auth` names it.

The `authorization` argument and the `requireAuth()` result are a frozen `{ request, session, user }` object. Only the guards create it. A caller cannot pass its own value to the returned handler.

### GitHub organization membership

`isGitHubOrgMember(accessToken, org, options?)` returns `true` only when GitHub says the token's user is an active member of `org`. The token needs the `read:org` scope. A pending invitation, a non-2xx response, a network error, or a timeout returns `false`, so a failed check never lets a user in. It uses only `fetch` and Web Crypto, so it runs on Node, Workers, and other hosts.

| Option | Default | Use |
| --- | --- | --- |
| `cacheMs` | No cache | Keep a successful check this many milliseconds per token and organization. Failed checks are never kept. Cache keys are SHA-256 digests, not tokens, and expired keys are removed. |
| `timeoutMs` | `5000` | Stop the GitHub request after this many milliseconds. |

```ts [server/utils/members.ts]
import { isGitHubOrgMember } from 'vite-hub/auth'

export const isTeamMember = (token: string | null | undefined) => isGitHubOrgMember(token, 'acme', { cacheMs: 300_000 })
```

The cache is in memory, so each Worker isolate or server process has its own.

### Authorize access routes

Add `authorize` when a session alone is not enough. ViteHub calls it only after authentication.

| `authorize` returns | Result |
| --- | --- |
| `true` | The request continues. |
| `false` | `403`. |
| A `Response` | That response, as-is. |

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

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

The generated access middleware checks each request that an access route matches. A route ending in `/**` matches its base path and descendants. Exact routes match only that path. All matching rules apply. Unmatched requests do not load the Auth Definition or session.

The [Console](/docs/development/console#protect-the-console-route) endpoint does not use these access routes. It takes only signed requests and one-time links.

## Typed user fields

The default client gets its types from the Auth Definition. When the Definition adds user or session fields, with `additionalFields`, with a plugin such as `admin()`, or with the session that `customSession()` returns, `useUserSession()` has these fields too.

```ts [server/auth.ts]
import { admin } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  plugins: [admin()],
  user: {
    additionalFields: {
      plan: { type: ['free', 'pro'], required: true, input: false },
    },
  },
})
```

```ts [lib/plan.ts]
import { useUserSession } from 'vite-hub/auth/vue'

const { user } = useUserSession()

export const isPro = () => user.value?.plan === 'pro'
export const isAdmin = () => user.value?.role === 'admin'
```

- ViteHub writes the type of the Definition to `.vitehub/types/auth.d.ts`. The client imports only this type, so no server code goes to the browser.
- In Nuxt, the auto-imported `useUserSession()` has the same types.
- A client from `createAuthClient()` does not get these fields. Add the Better Auth client plugins, such as `adminClient()` and `customSessionClient<RegisteredAuth>()`, and `inferAdditionalFields<RegisteredAuth>()` from `better-auth/client/plugins`. `RegisteredAuth` is a type from `vite-hub/auth`.
