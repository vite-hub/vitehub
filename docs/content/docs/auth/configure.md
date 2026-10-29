---
title: Auth configuration
description: Write the Auth Definition, supply runtime options, and record storage placement.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Auth Definition

Create one Primary Auth Definition in `server/auth.ts` or `server.auth.ts`. ViteHub also accepts the `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs` extensions. More than one Definition fails the build.

In a Nuxt application, a layer can supply `server/auth.ts`. An application Definition replaces it. Auth Definitions in two layers fail the build until the application defines one.

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
| `preset` | `stateless()` | None | Sets the Better Auth options of a preset and checks the other options against it. See [Sessions without a database](#sessions-without-a-database). |
| `basePath` | `string` | `/api/auth` | Sets the Auth Base Path. It must start with `/`. |
| `route` | `false` | Enabled | Disables automatic Auth route exposure. |
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes guarded by generated Auth access middleware. Use a route string, or an object with `route`, optional `method`, and optional `authorize`. |
| `access.signIn` | `{ provider, callbackURL?, errorCallbackURL?, requestSignUp?, scopes? }` | None | Redirect behavior for HTML requests that `withAuth()` or `requireAuth()` rejects. |
| `runtime` | Options object or `(context) => options` | None | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, `secrets`, and storage adapters. |
| `session.onRefresh` | `({ session, user, refresh, clear }) => void` | None | Runs when Better Auth refreshes a stored session. See [Session refresh](#session-refresh). |

`baseURL`, `secret`, and `secrets` are runtime-only. Return them from a Definition callback or put them under `runtime`, not as static top-level fields. `access.routes` must be static so the Vite Integration can register middleware.

### Secret

You do not need a Better Auth secret when the deployment sets [`VITEHUB_SECRET`](/docs/env/app-secret). Without `secret` or `secrets`, and without `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, or `AUTH_SECRET` in the environment, Auth signs with `deriveSecret('vitehub:auth')`. Auth reads `VITEHUB_SECRET`, then `NUXT_APP_SECRET`, from the server's process environment and the Cloudflare bindings of the request. A configured Better Auth secret always wins. Without any secret, Better Auth applies its own rules: a development default, and an error in production. A root secret shorter than 32 characters throws `AUTH_R0016`. Rotating `VITEHUB_SECRET` signs out every session.

## Runtime options

Use a Definition callback or the `runtime` field when values depend on the request, Server Env, provider credentials, or request origin. Declare the secrets in [Env](/docs/env) first.

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

Without a `baseURL`, Auth uses `vitehub({ publicUrl })`, then the request origin. When Nitro serves the app below a path, such as Nuxt `app.baseURL: '/app/'`, Auth serves its routes and OAuth callbacks below that path, such as `/app/api/auth`. Set `baseURL` to an origin; Better Auth ignores `basePath` when `baseURL` has a path. Each Auth request or route guard resolves the Definition and `runtime` callbacks once. A later request resolves fresh options.

## Sessions without a database

Use the `stateless()` preset when users sign in only with social providers and the app has no database. Each session is in an encrypted cookie, so it survives restarts and works across replicas and Workers.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'
import { stateless } from '@vite-hub/auth/presets'

export default defineAuth(({ env, requestOrigin }) => ({
  baseURL: requestOrigin,
  preset: stateless({ maxAge: '7d' }),
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}))
```

With `vite-hub`, import it from `vite-hub/auth/presets`. `maxAge` is the session lifetime in seconds or a duration: `'30m'`, `'12h'`, `'7d'`, or `'2w'`. The default is 7 days. The preset sets these Better Auth options:

| Better Auth option | Value |
| --- | --- |
| `session.expiresIn` | `maxAge` |
| `session.cookieCache` | `{ enabled: true, strategy: 'jwe', refreshCache: true, maxAge }` |
| `account.storeStateStrategy` | `'cookie'` |
| `account.storeAccountCookie` | `true` |

Every instance must use the same [secret](#secret). The secret encrypts the cookies, so an instance with another secret sees no session. The session ends `maxAge` after sign-in. Use does not extend it. You cannot revoke one session. Sign-out removes the cookies from that browser only. To sign out every user, change `session.cookieCache.version` or rotate the secret. The session cookie holds a copy of the user from sign-in, and also the provider tokens. Providers that issue large tokens can exceed browser or proxy header limits.

`preset` is a ViteHub option, so ViteHub can check the other options. These combinations fail when the Auth Definition is defined, or when a callback or `runtime` resolves:

| Code | Combination |
| --- | --- |
| `AUTH_C0044` | `database`, metadata or an adapter |
| `AUTH_C0045` | `secondaryStorage` |
| `AUTH_C0046` | `emailAndPassword.enabled`, because users and passwords need a database |
| `AUTH_C0047` | A Better Auth plugin that adds tables or fields, such as `jwt()`, `admin()`, or `organization()`, or one that stores verification tokens, such as `magicLink()`, `emailOTP()`, or `oneTimeToken()` |
| `AUTH_C0048` | An option that the preset sets, from the table above. Pass `maxAge` to `stateless()` instead. |

For revocable sessions, user records, or email and password, remove the preset and configure a database adapter.

### User ID

There are no stored users, so Better Auth creates the user again at each sign-in. The preset gives that user an ID derived from the provider account: the first 32 hex digits of SHA-256 over the provider ID, such as `github`, and the account ID that the provider returns. The same provider account gets the same `user.id` on every sign-in, instance, and restart, so you can key app data and [Agent Invokers](/docs/agents/invokers) by it. The same account ID on two providers gives two IDs. The ID does not depend on the secret. It is not a secret: anyone who knows the provider account ID can compute it.

The preset sets the ID through Better Auth's `user.validateUserInfo` and `databaseHooks.user.create.before`. Your own hooks still run. The preset sets `id` after your `create.before` hook, so that hook cannot change it. A provider that returns no account ID fails sign-in with `vitehub_account_subject_missing`. A user who signs in with two providers gets two IDs. In a process that keeps one Better Auth instance, Better Auth can link the second provider to the first user by email until the process restarts.
## Session refresh

Better Auth extends a stored session when the session passes `session.updateAge`. `session.onRefresh` runs at that time, so you can check the user again, for example against a ban list, before the session continues.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  session: {
    updateAge: 60 * 60,
    async onRefresh({ session, user, refresh, clear }) {
      const account = await findAccount(user.id)
      if (account.banned) return clear()
      refresh()
    },
  },
})
```

| Call | Result |
| --- | --- |
| `refresh()` | Better Auth extends the session by `session.expiresIn`. |
| `refresh(fields)` | Better Auth extends the session and writes `fields` to it, for example session `additionalFields`. The response and the cookie cache contain them. |
| Neither | The session keeps its current expiry. The next request that reaches the refresh runs the hook again. |
| `clear()` | Better Auth deletes the session, removes its cookies, and answers `401`. `withAuth()` and route guards treat it as no session. `clear()` wins over `refresh()`. |

The hook receives the `session` and `user` as stored before the refresh. To change user fields, update them in your own store. The current response still contains the user that Better Auth read before the refresh.

The hook runs for every Better Auth path that refreshes a stored session: `/get-session`, `auth.api.getSession()`, and endpoints that read the session. It does not run for other session updates, such as `/update-session`.

`onRefresh` needs a Better Auth `database` or `secondaryStorage` adapter. Without one, Auth fails with `AUTH_C0042`. Better Auth refreshes a stateless cookie cache (`session.cookieCache.refreshCache`) without a hook, so ViteHub cannot run `onRefresh` there. With a cookie cache in front of a database, the hook runs only when Better Auth reads the database. It does not run when `session.disableSessionRefresh` is set or for a session created without "remember me". With `session.deferSessionRefresh`, it runs on the `POST` that writes the refresh.

## Session marker cookie

When a response sets the session cookie, ViteHub Auth also sets `vitehub_session=1`. It has the session cookie's lifetime, path, domain, `SameSite`, `Secure`, and `Partitioned` attributes, and Better Auth clears it when it clears the session cookie, such as on sign-out. Unlike the session cookie it is not `HttpOnly`, so a page script can read it. It holds no secret and proves nothing: the server still checks the session on every request. The [comments overlay](/docs/comments/operations/configure#content-security-policy-and-privacy) can use it to skip the session request for visitors who never signed in when marker mode is enabled.

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
