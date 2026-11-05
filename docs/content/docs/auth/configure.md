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
| `database` | `authDatabase(name?)`, or `true \| { name, dedicated? }` | In-memory store | `authDatabase()` keeps users and sessions in an app Database and adds the Better Auth tables to it. See [Keep users in the app Database](#keep-users-in-the-app-database). `true` and `{ name }` only record the intended Database for inspection. |
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
| `requestOrigin` | The origin of the current request. With [`advanced.trustedProxyHeaders`](#behind-a-proxy-that-ends-tls), the origin the client used. Same-origin apps do not need a separate auth URL variable. |
| `request` | The current request headers and URL, when a request exists. |

Without a `baseURL`, Auth uses `vitehub({ publicUrl })`, then the request origin. When Nitro serves the app below a path, such as Nuxt `app.baseURL: '/app/'`, Auth serves its routes and OAuth callbacks below that path, such as `/app/api/auth`. Set `baseURL` to an origin; Better Auth ignores `basePath` when `baseURL` has a path. Each Auth request or route guard resolves the Definition and `runtime` callbacks once, except for the proxy origin recalculation below. A later request resolves fresh options.

### Behind a proxy that ends TLS

On a server behind Caddy, nginx, or Traefik, Node sees `http://` requests on an internal address, so `requestOrigin` and the default `baseURL` would start with `http://`. Set Better Auth's `advanced.trustedProxyHeaders` to read the origin from the first `X-Forwarded-Proto` and `X-Forwarded-Host` values instead. Without `X-Forwarded-Host`, the host comes from the request. `vitehub({ publicUrl })` still wins over both.

```ts [server/auth.ts]
export default defineAuth(({ env, requestOrigin }) => ({
  advanced: { trustedProxyHeaders: true },
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
}))
```

Turn it on only when a proxy you run sets these headers. Without one, a client can send them and choose the origin of callback URLs and emailed links. Proxy trust follows the normal option precedence: caller runtime options override the `runtime` result, which overrides the Definition. The `advanced` object is replaced as a whole. Callbacks first run with the request URL's origin; when the effective options enable proxy trust and the forwarded origin differs, they run a second time with that origin. If the second run disables trust, Auth discards the forwarded values and disables proxy trust. Auth checks the `Origin` of requests against the resulting `baseURL` by default.

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

For revocable sessions, user records, or email and password, remove the preset and use [`authDatabase()`](#keep-users-in-the-app-database).

### User ID

There are no stored users, so Better Auth creates the user again at each sign-in. The preset gives that user an ID derived from the provider account: the first 32 hex digits of SHA-256 over the provider ID, such as `github`, and the account ID that the provider returns. The same provider account gets the same `user.id` on every sign-in, instance, and restart, so you can key app data and [Agent Invokers](/docs/agents/invokers) by it. The same account ID on two providers gives two IDs. The ID does not depend on the secret. It is not a secret: anyone who knows the provider account ID can compute it.

The preset sets the ID through Better Auth's `user.validateUserInfo` and `databaseHooks.user.create.before`. Your own hooks still run. The preset sets `id` after your `create.before` hook, so that hook cannot change it. A provider that returns no account ID fails sign-in with `vitehub_account_subject_missing`. A user who signs in with two providers gets two IDs. In a process that keeps one Better Auth instance, Better Auth can link the second provider to the first user by email until the process restarts.
## Session refresh

Better Auth extends a stored session when the session passes `session.updateAge`. `session.onRefresh` runs at that time, so you can check the user again, for example against a ban list, before the session continues.

```ts [server/auth.ts] fragment
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

When a response sets the session cookie, ViteHub Auth also sets `vitehub_session=1`. It has the session cookie's lifetime, path, domain, `SameSite`, `Secure`, and `Partitioned` attributes, and Better Auth clears it when it clears the session cookie, such as on sign-out. Unlike the session cookie it is not `HttpOnly`, so a page script can read it. It holds no secret and proves nothing: the server still checks the session on every request. The [page tools](/docs/comments/configure#turn-comment-mode-on-and-off) read it to load comment mode for a person who just signed in.

When a session starts or ends, ViteHub Auth also clears the `vitehub-tools` cookie of the [ViteHub tools pill](/docs/development/console#open-the-console-from-the-apps-pages). The next page then asks whether the new person may use the Console or Comments, so the pill shows right after sign-in and goes away after sign-out. A session refresh keeps the same session and keeps the cookie.

## Keep users in the app Database

Pass `authDatabase()` as `database`. Better Auth then keeps users, sessions, accounts, and verifications in the app Database, and Auth adds their tables to that Database through the Database integration:

```ts [server/auth.ts]
import { admin } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'

export default defineAuth({
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [admin()],
})
```

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

- `authDatabase()` uses the `default` Database. Pass a name, such as `authDatabase('content')`, for a Named Database. Write the call inline in `defineAuth()`, in the object or in the object that the callback returns, so that the Vite integration can read it.
- Keep one unconditional Database target. A callback must return one object with the inline call; branches and `runtime.database` cannot select another target. Other runtime options still work.
- The owned tables use text IDs and text references. Use Better Auth's default ID generator or a custom function returning strings. `advanced.database.generateId` values `serial`, `uuid`, and `false` require another adapter and a schema that you own; `authDatabase()` rejects them with `AUTH_C0053`.
- The owned core tables have fixed columns. For `additionalFields` on `user`, `session`, `account`, or `verification`, including Console profile fields, use another Better Auth adapter and a schema that includes those columns. `authDatabase()` rejects these options with `AUTH_C0055`; a Database contribution cannot extend the owned tables.
- Plugins may use the owned columns of `admin()`, `jwt()`, and `oauthProvider()`. Plugins that add other columns to an owned table, such as `username()`, fail with `AUTH_C0056` before the adapter opens the Database. Model and field remapping on owned tables also fail with `AUTH_C0056`; use another adapter and a matching schema for those options.
- The tables are the Better Auth core tables (`user`, `session`, `account`, `verification`), the fields of the [`admin()`](https://www.better-auth.com/docs/plugins/admin) plugin (`user.role`, bans, and `session.impersonatedBy`), and the `jwks` and `oauth*` tables that [Console MCP OAuth](/docs/development/mcp#set-up-oauth) needs. Column names follow the Better Auth CLI.
- The tables use the dialect of the target Database: SQLite, libSQL, and Cloudflare D1, or Postgres. Without a Database Definition, the Database integration adds the implicit `default` Database for them.
- `vitehub inspect definitions --kind database` lists the `auth` tables with `@vite-hub/auth/vite` as their plugin. The tables are also in `useDatabase(name).schema`, so server code can read them.
- Other plugins that add tables, such as `organization()`, need their tables in the Database Definition. A table that the Database does not have fails when Better Auth uses it.
- Without the tables, the adapter fails with `AUTH_R0019`. It does not fall back to the in-memory store.

Better Auth's own adapters still work. Return one from the Definition callback or `runtime` when Auth uses another database.

## Give the first admin role

Set `VITEHUB_ADMIN_EMAILS` to a comma-separated list of emails. A new account with one of them gets the admin role of Better Auth's `admin()` plugin: an email and password sign-up, or the first sign-in with a social provider. Existing accounts keep their role. The Auth Console shows the rule in its access notes.

```bash [Terminal]
VITEHUB_ADMIN_EMAILS=you@example.com pnpm dev
```

On Cloudflare, store it as a Worker variable or secret, for example `pnpm exec wrangler secret put VITEHUB_ADMIN_EMAILS`. The role is the first entry of `admin({ adminRoles })`, `admin` by default. Without `admin()` in `plugins`, Auth fails with `AUTH_C0051`.

The assignment runs after an application's `databaseHooks.user.create.before` hook, preserving its other fields and any cancellation. A hook's returned role cannot demote a new account with a listed email.

The first account that signs up with a listed email gets the role. This is a bootstrap rule and does not prove email ownership. For email and password sign-up, restrict access to the deployment until you have created the admin account, then unset `VITEHUB_ADMIN_EMAILS` before opening public sign-up. Email verification alone does not protect this bootstrap: someone else can register the address with their own password, and keep that password if the mailbox owner follows the verification link. If the address has already been registered by someone else, remove that account through your trusted administration process before bootstrapping.

## Sign MCP clients in

An app with its own MCP server, such as `/mcp`, can make Better Auth its OAuth 2.1 authorization server. An MCP client such as Claude Code, Codex, or Cursor then registers itself, opens the browser once, and sends a bearer token. For the Console endpoint `/_vitehub/mcp`, use [Console MCP OAuth](/docs/development/mcp#set-up-oauth) instead.

Install `@better-auth/oauth-provider` at the version of `better-auth` that ViteHub uses, then add `mcpOAuth()` to the Auth. It returns `jwt()`, `oauthProvider()`, and a registration guard:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { mcpOAuth } from 'vite-hub/auth/mcp'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  database: authDatabase(),
  plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: '/oauth' })],
}))
```

| Option | Default | Use |
| --- | --- | --- |
| `resource` | required | The absolute URL of each MCP endpoint, or a list. Tokens name it as their audience. |
| `loginPage` | required | The page where a signed-out person signs in. |
| `consentPage` | `loginPage` | The page where a signed-in person allows or denies the client. |
| `scopes` | none | Scopes in addition to `openid`, `profile`, `email`, and `offline_access`. |
| `issuer` | the Better Auth base URL | The `iss` of the tokens, such as `https://app.example.com/api/auth`. |
| `registration.maxBytes` | 16 KiB | The largest client registration body. |
| `provider` | none | Other `oauthProvider()` options, such as `codeExpiresIn`. They win over the defaults. |

Registration is open to anyone, as MCP clients expect, so `mcpOAuth()` bounds it. A body over `registration.maxBytes` gets `413` before Better Auth parses it. A registration with no redirect URI or more than 5, a field over 2048 characters, a list over 10 entries, or a `client_name` over 160 characters gets `400` with `invalid_client_metadata`. A client that sends no `application_type` and only loopback or private-use redirects, as Claude Code, Codex, and Cursor do, is a native client. Better Auth's limiter allows 5 registrations per minute and IP. It is on in production. Its default storage is the memory of one Auth instance, so set Better Auth `rateLimit.storage` to `database` or `secondary-storage` when the server runs more than one instance, or when the Auth follows `requestOrigin` and is built for each request.

When Better Auth has a `secondaryStorage` adapter, also set `session: { storeSessionInDatabase: true }`. OAuth Provider requires database-backed sessions with secondary storage, including when `rateLimit.storage` is `secondary-storage`.

These helpers support bearer tokens. Registration with `dpop_bound_access_tokens: true` gets `400 invalid_client_metadata`, and `verifyMcpRequest()` rejects DPoP-bound tokens even when sent as bearer tokens.

The login and consent pages get a signed query from Better Auth. Send its parameters back unchanged as `oauth_query`, as [Console MCP OAuth](/docs/development/mcp#set-up-oauth) explains. The plugins keep keys, clients, and tokens in the `jwks` and `oauth*` tables, which `authDatabase()` includes.

### Serve discovery at the origin root

MCP clients look for the metadata at the origin root. `serveMcpOAuthDiscovery(request)` answers `/.well-known/oauth-protected-resource/mcp` (RFC 9728) for each resource, and `/.well-known/oauth-authorization-server/api/auth` and `/.well-known/openid-configuration/api/auth` for the issuer, which Better Auth serves only below its own base path. The bare paths answer too. It returns `undefined` for every other path:

```ts [server/middleware/mcp-oauth.ts]
import { defineHandler } from 'h3'
import { serveMcpOAuthDiscovery } from 'vite-hub/auth/mcp'

export default defineHandler(event => serveMcpOAuthDiscovery(event.req, {
  resourceName: 'My app',
  resourceDocumentation: 'https://app.example.com/docs/agents',
}))
```

`resourceName` is the name a client shows before sign-in. With the Console on, the Console answers its own resource and issuer first and steps aside for the others.

### Check the token of an MCP request

`verifyMcpRequest(request)` returns `[error, caller]`. `caller` has the `user`, the approved `scopes`, the `clientId`, and the `clientName` that the client registered, such as `Claude Code`:

```ts [server/routes/mcp.ts]
import { verifyMcpRequest } from 'vite-hub/auth/mcp'

const [error, caller] = await verifyMcpRequest(event.req)
if (error) {
  return new Response(null, {
    status: 401,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', event.req.url)}"${error.code === 'AUTH_MCP_TOKEN_INVALID' ? ', error="invalid_token"' : ''}` },
  })
}
```

It reads the signing keys from the Auth in the same process, with no request to the authorization server. It checks the signature against the algorithms of those keys, the issuer, the audience, and the expiry with 30 seconds of tolerance. Then it reads the user again by the `sub` claim, so a deleted or banned person loses access while the token is still valid. The OAuth client must still exist and be enabled. When the token names a session in `sid`, that session must still exist and be unexpired, so signing out ends its access. A token opens only the resource at the origin and path of the request. Pass `resource` to accept the token on other routes, such as the app API. Errors are `AUTH_MCP_TOKEN_MISSING` and `AUTH_MCP_TOKEN_INVALID`; see [Limits and errors](/docs/auth/limits-and-errors#auth_mcp_token_missing).

### Delete abandoned registrations

A client that registered but never finished sign-in stays in `oauthClient`. `deleteUnusedMcpClients()` deletes the clients older than one day that have no consent, no access token, and no refresh token, and returns `[error, { deleted }]`. Run it from a [Schedule](/docs/schedule):

```ts [server/schedules/oauth-cleanup.ts]
import { defineSchedule } from 'vite-hub/schedule'
import { deleteUnusedMcpClients } from 'vite-hub/auth/mcp'

export default defineSchedule({
  cron: '0 3 * * *',
  async handler() {
    const [error, result] = await deleteUnusedMcpClients()
    if (error) throw error
    console.log(`Deleted ${result.deleted} unused MCP clients`)
  },
})
```

`olderThan` sets the age in milliseconds, and `limit` the number of clients that one call checks, 500 by default.

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

To persist Better Auth data, use [`authDatabase()`](#keep-users-in-the-app-database), or return a concrete Better Auth `database` or `secondaryStorage` adapter from the Definition callback or its `runtime` field. The placement metadata does not substitute for that adapter.

## Vite Integration options

`hubAuth()` accepts `false` to disable Auth integration. The Vite config key `auth` overrides the plugin argument.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
  auth: false,
})
```
