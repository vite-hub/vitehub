---
title: Auth configuration
description: Write the Auth Definition, pass runtime options, and choose where users and sessions live.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Auth Definition

The Auth Definition is the `defineAuth()` file: `server/auth.ts` or `server.auth.ts`, also as `.mts`, `.cts`, `.js`, `.mjs`, or `.cjs`. Two Definitions fail the build.

In Nuxt, a layer can supply `server/auth.ts`, and the app's own Definition replaces it. Definitions in two layers fail the build until the app defines one.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: {
    enabled: true,
  },
})
```

`defineAuth()` takes Better Auth server options at the top level, plus these ViteHub fields.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| Better Auth options | `AuthBetterAuthOptions` | Better Auth defaults | Passed to `betterAuth()` without the ViteHub fields. |
| `database` | `authDatabase(name?)` or `"memory"` | Memory on a development server. A build fails with `AUTH_C0063`. | [`authDatabase()`](#keep-users-in-the-app-database) keeps users and sessions in an app Database and adds the Better Auth tables to it. Return another Better Auth adapter from the Definition callback. See [Storage adapters](#storage-adapters). |
| `secondaryStorage` | None in the static options | Disabled | Return a Better Auth `secondaryStorage` adapter from the Definition callback. |
| `preset` | `stateless()` | None | Sets a preset's Better Auth options and checks the other options against it. See [Sessions without a database](#sessions-without-a-database). |
| `basePath` | `string` | `/api/auth` | Auth Base Path. Must start with `/`. |
| `route` | `false` | Enabled | Turns off the automatic Auth route. |
| `access.routes` | `AuthAccessRoute[]` | `[]` | Routes that the generated access middleware guards. A route string, or an object with `route` and optional `method` and `authorize`. |
| `access.public` | `string[]` | `[]` | Paths that no access route guards. With `routes: ['/**']`, the only paths a signed-out visitor can open. See [Make every route private](/docs/auth/server-api#make-every-route-private). |
| `access.policy` | `{ allow, recheck? }` | None | Who can sign in and stay signed in. See [Decide who can stay signed in](/docs/auth/server-api#decide-who-can-stay-signed-in). |
| `access.signIn` | `{ provider, callbackURL?, errorCallbackURL?, requestSignUp?, scopes? }` | None | Where to redirect HTML requests that `withAuth()` or `requireAuth()` rejects. |
| `session.onRefresh` | `({ session, user, refresh, clear }) => void` | None | Runs when Better Auth refreshes a stored session. See [Session refresh](#session-refresh). |

`baseURL`, `secret`, and `secrets` are runtime-only. Return them from a Definition callback, never as static top-level fields. `access.routes` and `access.public` must be static so the Vite integration can register middleware.

### Secret

When the deployment sets [`VITEHUB_SECRET`](/docs/env/app-secret), you need no Better Auth secret. Without `secret`, `secrets`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, or `AUTH_SECRET`, Auth signs with `deriveSecret('vitehub:auth')`.

- Auth reads `VITEHUB_SECRET` from the process environment and the request's Cloudflare bindings.
- A configured Better Auth secret always wins.
- With no secret at all, Better Auth uses a development default and throws in production.
- A root secret shorter than 32 characters throws `AUTH_R0016`.
- Rotating `VITEHUB_SECRET` signs out every session.

## Runtime options

When values depend on the request, Server Env, provider credentials, or request origin, pass a callback to `defineAuth()`. The callback returns all the options, the static ones too. Auth does not merge it with other options, so each nested object, such as `advanced`, has all its fields in one place. Declare the secrets in [Env](/docs/env) first.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
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
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
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
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
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
  })],
})
```
:::
::

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

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
| `env` | Typed Server Env, when the Env Vite integration is registered. `vitehub()` registers it by default. |
| `requestOrigin` | The current request's origin. With [`advanced.trustedProxyHeaders`](#behind-a-proxy-that-ends-tls), the origin the client used. Same-origin apps need no separate auth URL variable. |
| `request` | The current request headers and URL, if there is a request. |

Without a `baseURL`, Auth uses `vitehub({ publicUrl })`. It uses the request origin only when `publicUrl` is unset. When Nitro serves the app below a path, such as Nuxt `app.baseURL: '/app/'`, Auth routes and OAuth callbacks live below it, such as `/app/api/auth`. Set `baseURL` to an origin only, because Better Auth ignores `basePath` when `baseURL` has a path. Each Auth request or route guard runs the Definition callback once (twice with proxy trust, below). Each new request gets fresh options. Requests with equal options share one Better Auth instance, and all guards of one request share one session lookup. A change to a variable that the instance uses, such as `VITEHUB_SECRET`, `BETTER_AUTH_SECRET`, or `VITEHUB_ADMINS`, gives a new instance on the next request. A callback that creates plugins or adapters on each call, other than `authDatabase()`, gets a new instance on each request. Create them outside the callback when they do not depend on the request.

### Behind a proxy that ends TLS

Behind Caddy, nginx, or Traefik, Node sees `http://` requests on an internal address, so `requestOrigin` and the default `baseURL` start with `http://`. When the proxy sends the client's `Host` header, set [`vitehub({ trustProxy: true })`](/docs/frameworks-hosts/node-self-hosted#run-behind-a-reverse-proxy): the request URL of every route, Auth included, becomes `https://`. Otherwise, set Better Auth's `advanced.trustedProxyHeaders` to read the origin from the first `X-Forwarded-Proto` and `X-Forwarded-Host` values. Without `X-Forwarded-Host`, the host comes from the request. `vitehub({ publicUrl })` still wins over both.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth(({ env, requestOrigin }) => ({
  advanced: { trustedProxyHeaders: true },
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
}))
```

::warning
Turn it on only when a proxy you run sets these headers. Without one, a client can send them and choose the origin of callback URLs and emailed links.
::

The callback first runs with the request URL's origin. If proxy trust is then on and the forwarded origin differs, they run again with that origin. If that run turns trust off, Auth drops the forwarded values and proxy trust. By default, Auth checks each request's `Origin` against the final `baseURL`.

## Sessions without a database

Use the `stateless()` preset when users sign in only with social providers and the app has no database. Each session lives in an encrypted cookie, so it survives restarts and works across replicas and Workers.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { stateless } from 'vite-hub/auth/presets'

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

With `vite-hub`, import it from `vite-hub/auth/presets`. `maxAge` is the session lifetime, in seconds or as `'30m'`, `'12h'`, `'7d'`, or `'2w'`. The default is 7 days. The preset sets these Better Auth options:

| Better Auth option | Value |
| --- | --- |
| `session.expiresIn` | `maxAge` |
| `session.cookieCache` | `{ enabled: true, strategy: 'jwe', refreshCache: true, maxAge }` |
| `account.storeStateStrategy` | `'cookie'` |
| `account.storeAccountCookie` | `true` |

- Every instance must use the same [secret](#secret). It encrypts the cookies, so an instance with another secret sees no session.
- The session ends `maxAge` after sign-in. Use does not extend it.
- You cannot revoke one session. Sign-out removes the cookies from that browser only. To sign out every user, change `session.cookieCache.version` or rotate the secret.
- The cookie holds a copy of the user from sign-in and the provider tokens. Large provider tokens can go over browser or proxy header limits.

Because `preset` is a ViteHub option, ViteHub checks the other options against it. These combinations fail when the Definition is created, or when a callback resolves:

| Code | Combination |
| --- | --- |
| `AUTH_C0044` | `database` |
| `AUTH_C0045` | `secondaryStorage` |
| `AUTH_C0046` | `emailAndPassword.enabled`, because users and passwords need a database |
| `AUTH_C0047` | A Better Auth plugin that adds tables or fields, such as `jwt()`, `admin()`, or `organization()`, or one that stores verification tokens, such as `magicLink()`, `emailOTP()`, or `oneTimeToken()` |
| `AUTH_C0048` | An option that the preset sets, from the table above. Pass `maxAge` to `stateless()` instead. |

For revocable sessions, stored users, or email and password, remove the preset and use [`authDatabase()`](#keep-users-in-the-app-database).

### User ID

With no stored users, Better Auth creates the user again at each sign-in. The preset sets its ID to the first 32 hex digits of SHA-256 over the provider ID, such as `github`, and the provider's account ID. One provider account gets the same `user.id` on every sign-in, instance, and restart, so you can key app data and [Agent Invokers](/docs/agents/invokers) by it. The same account ID on two providers gives two IDs. The ID does not use the secret, so anyone who knows the provider account ID can compute it.

The preset sets the ID through Better Auth's `user.validateUserInfo` and `databaseHooks.user.create.before`, after your `create.before` hook, so that hook cannot change it. A provider that returns no account ID fails sign-in with `vitehub_account_subject_missing`. A user who signs in with two providers gets two IDs, but a process that keeps one Better Auth instance can link them by email until it restarts.
## Session refresh

Better Auth extends a stored session once it is older than `session.updateAge`. `session.onRefresh` runs then, so you can check the user again, for example against a ban list.

```ts [server/auth.ts] fragment
import { defineAuth } from 'vite-hub/auth'

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
| `refresh(fields)` | Better Auth extends the session and writes `fields`, such as session `additionalFields`, to it. The response and cookie cache include them. |
| Neither | The session keeps its expiry. The next request that reaches the refresh runs the hook again. |
| `clear()` | Better Auth deletes the session, removes its cookies, and answers `401`. `withAuth()` and route guards treat it as no session. `clear()` wins over `refresh()`. |

The hook gets the `session` and `user` as stored before the refresh. To change user fields, update your own store. The current response still has the user from before the refresh.

The hook runs on every Better Auth path that refreshes a stored session: `/get-session`, `auth.api.getSession()`, and endpoints that read the session. Other session updates, such as `/update-session`, do not run it.

`onRefresh` needs a Better Auth `database` or `secondaryStorage` adapter, or Auth fails with `AUTH_C0042`.

- A stateless cookie cache (`session.cookieCache.refreshCache`) refreshes without a hook, so `onRefresh` cannot run there.
- With a cookie cache in front of a database, the hook runs only when Better Auth reads the database.
- It does not run with `session.disableSessionRefresh`, or for a session created without "remember me".
- With `session.deferSessionRefresh`, it runs on the `POST` that writes the refresh.

## Session marker cookie

With the session cookie, Auth also sets `vitehub_session=1`, with the same lifetime, path, domain, `SameSite`, `Secure`, and `Partitioned` attributes. Better Auth clears both together, such as on sign-out. It is not `HttpOnly`, so page scripts can read it. It holds no secret and proves nothing: the server still checks the session on every request. The [page tools](/docs/comments/configure#turn-comment-mode-on-and-off) read it to load comment mode right after sign-in.

When a session starts or ends, Auth clears the `vitehub-tools` cookie of the [ViteHub tools pill](/docs/comments/configure#turn-comment-mode-on-and-off). The next page checks if the new person may use Comments, so the pill appears at sign-in and goes away at sign-out. A session refresh keeps the cookie.

## Keep users in the app Database

Pass `authDatabase()` as `database`. Better Auth then keeps users, sessions, accounts, and verifications in the app Database, and Auth adds their tables through the Database integration:

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
pnpm vitehub database generate
pnpm vitehub database migrate
```

- `authDatabase()` uses the `default` Database. For a Named Database, pass its name, such as `authDatabase('content')`. Write the call inline in `defineAuth()`, in the object or the object the callback returns, so the Vite integration can read it.
- Keep one unconditional Database target. A callback must return one object with the inline call. Branches cannot pick another target. Other runtime options still work.
- The tables use text IDs and references. Use Better Auth's default ID generator or a custom function that returns strings. `advanced.database.generateId` values `serial`, `uuid`, and `false` need another adapter and your own schema. `authDatabase()` rejects them with `AUTH_C0053`.
- The core tables have fixed columns. For `additionalFields` on `user`, `session`, `account`, or `verification`, including Console profile fields, use another Better Auth adapter and a schema with those columns. `authDatabase()` rejects them with `AUTH_C0055`, and a Database contribution cannot extend these tables.
- `admin()`, `jwt()`, `oauthProvider()`, `organization()`, and `passkey()` from `@better-auth/passkey` work with the existing columns. A plugin that adds other columns, such as `username()`, or model and field remapping, fails with `AUTH_C0056` before the adapter opens the Database. Use another adapter and a matching schema instead.
- The tables are the Better Auth core tables (`user`, `session`, `account`, `verification`), the [`admin()`](https://www.better-auth.com/docs/plugins/admin) fields (`user.role`, bans, and `session.impersonatedBy`), the `jwks` and `oauth*` tables for [MCP OAuth](#sign-mcp-clients-in), the [`organization()`](https://www.better-auth.com/docs/plugins/organization) tables (`organization`, `member`, `invitation`, and `session.activeOrganizationId`), the [`passkey()`](https://www.better-auth.com/docs/plugins/passkey) table, and the `rate_limit` table of the [limiter](#rate-limiting). Column names follow the Better Auth CLI.
- The tables use the target Database's dialect: SQLite, libSQL, Cloudflare D1, or Postgres. Without a Database Definition, the Database integration adds the implicit `default` Database.
- `vitehub inspect definitions --kind database` lists the `auth` tables with `@vite-hub/auth/vite` as their plugin. Server code can read them from `useDatabase(name).schema`.
- Other plugins that only add tables need those tables in the Database Definition. A missing table fails when Better Auth uses it. `twoFactor()` also adds `user.twoFactorEnabled`, so it needs another adapter and a matching schema.
- Without the tables, the adapter fails with `AUTH_R0019`. It never falls back to the in-memory store.

Better Auth's own adapters still work. To use another database, return one from the Definition callback.

## Rate limiting

Better Auth's limiter allows 100 requests per 10 seconds per client IP and path, 3 per 10 seconds for sign-in and sign-up, plus stricter plugin rules. Auth sets it up the same way on every host:

- It is on outside a dev server. The Auth Vite plugin marks `vite dev` and a Nitro dev server, so a Cloudflare Worker, which has no `NODE_ENV`, still limits requests. Set `rateLimit.enabled` to choose yourself.
- The client IP is the address the host reports: `cf-connecting-ip` on Cloudflare, the peer address on Node. Auth ignores `X-Forwarded-For`, which a client can set. With [`advanced.trustedProxyHeaders`](#behind-a-proxy-that-ends-tls), the peer is your proxy, so Auth reads `X-Forwarded-For` first. To read other headers, set `advanced.ipAddress.ipAddressHeaders`.
- With [`authDatabase()`](#keep-users-in-the-app-database), counters live in the `rate_limit` table, shared by every instance and every per-request Auth. With `secondaryStorage`, they live in that store. Otherwise they live in process memory. Set `rateLimit.storage` or `rateLimit.customStorage` to choose yourself.

Auth passes the address in the `x-vitehub-client-address` header and removes any value a client sends. `auth.api` calls skip the limiter. An `auth.api` call with only `headers` has no client IP, so its sessions have an empty `session.ipAddress`.

A manual host that turns requests into plain Web `Request` objects must call the `createAuthHandler()` handler as `handler(request, { clientAddress })` with the host's peer address. Without it, these requests share one rate-limit bucket with no address. See [Mount a server handler](/docs/frameworks-hosts/node-self-hosted#mount-a-server-handler).

## Give the first admin role

Set `VITEHUB_ADMINS` to the social accounts that get the admin role, separated by commas. Each entry is `<provider>:<account id>`, the pair that Better Auth stores in the `account` table:

```bash [Terminal]
VITEHUB_ADMINS=github:22072217 pnpm dev
```

A GitHub entry uses the numeric account id, because someone can rename a login and someone else can take the old one. Find it with `gh api users/<login> --jq .id`.

When a listed account signs in, or is linked to a user, the user gets the first role of `admin({ adminRoles })`, `admin` by default. The role replaces the default role of `admin()` and joins the user's other roles. An entry added later works on the account's next sign-in. Removing an entry does not remove the role: an admin changes it in the Auth Console, which shows the rule in its access notes.

On Cloudflare, store it as a Worker variable or secret, for example `pnpm exec wrangler secret put VITEHUB_ADMINS`. Without `admin()` in `plugins`, Auth fails with `AUTH_C0051`.

`VITEHUB_ADMINS` takes no emails. An email and password sign-up does not prove that the person owns the email, so the first person to sign up with the admin's email would get the role. An email entry fails with `AUTH_C0058`, and the removed `VITEHUB_ADMIN_EMAILS` fails with `AUTH_C0057`.

### Claim the admin role with a code

An app with only email and password sign-in has no social account to list. Create a one-time claim code instead:

```bash [Terminal]
$ vitehub auth claim
Claim code: 7KQF-2M9D-XW4P-R8TB
This is the only time the code is shown. Keep it private.

Set this variable on the host, for example as a Worker secret:
VITEHUB_ADMIN_CLAIM=sha256:3f9a...
```

Set `VITEHUB_ADMIN_CLAIM` to the printed value. The host stores only the SHA-256 of the code. Then sign in to the app, and send the code to the claim route below, for example from your own admin page. The first signed-in user who enters it gets the admin role, and the code stops working. A database row in the `verification` table marks the use, so two instances cannot both accept the code. Better Auth's rate limit allows five tries a minute.

The routes are `GET <auth base>/vitehub/admin-claim/status`, which answers `{ "available": true }` until the code is used, and `POST <auth base>/vitehub/admin-claim` with `{ "code": "..." }`. Both need a session. A wrong code answers `403` and a used code `409`. Run `vitehub auth claim --json` for the code and value as JSON. A value that is not `sha256:` and 64 hex characters fails with `AUTH_C0059`.

Set `adminClaim: false` on another Auth Definition to make it ignore the host's claim value.

With a claim code set, Auth sets `verification.storeInDatabase: true`, including when sessions use `secondaryStorage`. Claim markers use only the database, so a secondary-storage outage cannot block reservation recovery. A failed role grant releases the reservation so the code can be tried again.

## Sign MCP clients in

An app with its own MCP server, such as `/mcp`, can use Better Auth as its OAuth 2.1 authorization server. An MCP client such as Claude Code, Codex, or Cursor then registers itself, opens the browser once, and sends a bearer token.

With `vitehub({ auth: true, mcp: true })`, the [app MCP server](/docs/mcp/configure#sign-in-with-mcp-oauth) checks the token and answers the discovery documents for you. Add `mcpOAuth()` below. The other helpers are for an MCP server that you write yourself.

Install `@better-auth/oauth-provider` at the same version as ViteHub's `better-auth`, then add `mcpOAuth()`. It returns `jwt()`, `oauthProvider()`, and a registration guard:

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
| `resource` | required | The absolute URL of the MCP endpoint, or a list. Tokens name it as their audience. |
| `loginPage` | required | The page where a signed-out person signs in. |
| `consentPage` | `loginPage` | The page where a signed-in person allows or denies the client. |
| `scopes` | none | Scopes in addition to `openid`, `profile`, `email`, and `offline_access`. |
| `issuer` | the Better Auth base URL | The `iss` of the tokens, such as `https://app.example.com/api/auth`. |
| `registration.maxBytes` | 16 KiB | The largest client registration body. |
| `provider` | none | Other `oauthProvider()` options, such as `codeExpiresIn`. They override the defaults. |

Registration is open to anyone, as MCP clients expect, so `mcpOAuth()` limits it:

- A body over `registration.maxBytes` gets `413` before Better Auth parses it.
- No redirect URI or more than 5, a field over 2048 characters, a list over 10 entries, or a `client_name` over 160 characters gets `400` with `invalid_client_metadata`.
- A client with no `application_type` and only loopback or private-use redirects, like Claude Code, Codex, and Cursor, counts as a native client.
- Better Auth's limiter allows 5 registrations per minute per client IP. [Rate limiting](#rate-limiting) says when it is on and where it keeps counters.

With a Better Auth `secondaryStorage` adapter, also set `session: { storeSessionInDatabase: true }`. OAuth Provider needs database sessions with secondary storage, also when `rateLimit.storage` is `secondary-storage`.

These helpers support only bearer tokens. Registration with `dpop_bound_access_tokens: true` gets `400 invalid_client_metadata`, and `verifyMcpRequest()` rejects DPoP-bound tokens even when sent as bearer tokens.

The plugins keep keys, clients, and tokens in the `jwks` and `oauth*` tables, which `authDatabase()` includes.

Better Auth sends a signed-out person to `loginPage`, and a signed-in person to `consentPage`. Both pages get a signed query:

1. Better Auth sends the person to your page with a signed query: the parameters named by `ba_param`, plus `sig`.
2. Send those parameters back unchanged, in order, as `oauth_query` in the sign-in request body, such as `/api/auth/sign-in/email`. The response has the `url` of the next step.
3. The signed-in person comes back to the consent page. Show the client name from `/api/auth/oauth2/public-client?client_id=…`, and send `{ accept, oauth_query }` to `/api/auth/oauth2/consent`.
4. Go to the `url` in its response.

Better Auth's `oauthProviderClient()` adds `oauth_query` to client requests for you.

### Serve discovery at the origin root

MCP clients look for metadata at the origin root, but Better Auth serves issuer metadata only below its base path. `serveMcpOAuthDiscovery(request)` answers `/.well-known/oauth-protected-resource/mcp` (RFC 9728) for each resource, and `/.well-known/oauth-authorization-server/api/auth` and `/.well-known/openid-configuration/api/auth` for the issuer. The bare paths answer too. Other paths return `undefined`:

```ts [server/middleware/mcp-oauth.ts]
import { defineHandler } from 'h3'
import { serveMcpOAuthDiscovery } from 'vite-hub/auth/mcp'

export default defineHandler(event => serveMcpOAuthDiscovery(event.req, {
  resourceName: 'My app',
  resourceDocumentation: 'https://app.example.com/docs/agents',
}))
```

`resourceName` is the name a client shows before sign-in. With the Console on, the Console answers its own resource and issuer first and leaves the others.

### Check the token of an MCP request

`verifyMcpRequest(request)` returns `[error, caller]`. `caller` has the `user`, approved `scopes`, `clientId`, and the registered `clientName`, such as `Claude Code`:

```ts [server/routes/mcp.ts]
import { verifyMcpRequest } from 'vite-hub/auth/mcp'

export default {
  async fetch(request: Request) {
    const [error, caller] = await verifyMcpRequest(request)
    if (error) {
      return new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', request.url)}"${error.code === 'AUTH_MCP_TOKEN_INVALID' ? ', error="invalid_token"' : ''}` },
      })
    }
    return Response.json({ client: caller.clientName })
  },
}
```

It reads only the request URL and headers, so a Fetchable route's Request, H3's `event.req` or any value with `url` and `headers` works, and the body stays for the MCP handler. It takes the signing keys from the Auth in the same process, with no call to the authorization server, and checks:

- The signature, against the algorithms of those keys, plus the issuer, the audience, and the expiry with 30 seconds of tolerance.
- The user, read again by the `sub` claim, so a deleted or banned person loses access while the token is still valid. With [`access.policy`](/docs/auth/server-api#decide-who-can-stay-signed-in), `allow` must also accept the user.
- The OAuth client, which must still exist and be enabled.
- The session, when the token names one in `sid`. It must still exist and be unexpired, so sign-out ends access. A token with the `offline_access` scope skips this: the person allowed access while signed out, and the client keeps it until its refresh token expires or the client is disabled or deleted.

A token opens only the resource at the request's origin and path. To accept it on other routes, such as the app API, pass `resource`. Errors are `AUTH_MCP_TOKEN_MISSING` and `AUTH_MCP_TOKEN_INVALID`. See [Limits and errors](/docs/auth/limits-and-errors#auth_mcp_token_missing).

### Delete abandoned registrations

A client that registered but never finished sign-in stays in `oauthClient`. `deleteUnusedMcpClients()` deletes clients older than one day with no consent, access token, or refresh token, and returns `[error, { deleted }]`. Run it from a [Schedule](/docs/schedule):

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

`olderThan` sets the age in milliseconds. `limit` sets how many clients one call checks, 500 by default.

## Storage adapters

`database` and `secondaryStorage` take Better Auth adapters only.

- In a static Definition, `database` takes only [`authDatabase()`](#keep-users-in-the-app-database) or `"memory"`. `authDatabase('auth')` uses the Named Database `auth`.
- `"memory"` keeps users and sessions in the memory of one server process. A restart removes them, and a second instance does not see them.
- Without `database` or `preset`, Auth uses memory only on a development server. A production build fails with `AUTH_C0063`. When the Auth Vite plugin did not build the server code, Auth reads `NODE_ENV`: only `development` and `test` count as a development server, and the first Auth request of any other server fails with `AUTH_C0063`.
- Return another Better Auth `database` adapter, or a `secondaryStorage` adapter, from the Definition callback.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'

export default defineAuth({
  appName: 'Acme',
  database: authDatabase('auth'),
})
```

`true`, `{ name }`, and `{ store }` do not create storage. Auth rejects them at build time (`AUTH_C0014`, `AUTH_C0017`), when the Definition loads (`AUTH_C0021`, `AUTH_C0024`), and when a callback returns them (`AUTH_C0061`, `AUTH_C0062`).

## Vite Integration options

`hubAuth(false)` turns the Auth integration off. Vite does not read a top-level `auth` key.

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth(false)],
})
```
