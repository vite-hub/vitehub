---
title: Auth configuration
description: Write the Auth Definition, supply runtime options, and record storage placement.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

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
| `access.signIn` | `{ provider, callbackURL?, errorCallbackURL?, requestSignUp?, scopes? }` | None | Redirect behavior for HTML requests that `withAuth()` rejects. |
| `runtime` | Options object or `(context) => options` | None | Supplies runtime-only Better Auth values such as `baseURL`, `secret`, `secrets`, and storage adapters. |

`baseURL`, `secret`, and `secrets` are runtime-only. Return them from a Definition callback or put them under `runtime`, not as static top-level fields. `access.routes` must be static so the Vite Integration can register middleware.

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

Without a `baseURL`, Auth uses `vitehub({ publicUrl })`, then the request origin. Each Auth request or route guard resolves the Definition and `runtime` callbacks once. A later request resolves fresh options.

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
