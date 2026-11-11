---
title: Better Auth on Cloudflare Workers and D1 with ViteHub
description: Run Better Auth on Cloudflare Workers from a Vite app with ViteHub. Keep users and sessions in Cloudflare D1, or use cookie sessions with no database.
navigation.title: Better Auth on Cloudflare
navigation.order: 30
navigation.group: Auth
icon: i-simple-icons-betterauth
---

Set `host: 'cloudflare'` and `auth: true` in `vitehub()`, and add `server/auth.ts` with `defineAuth()`. ViteHub mounts Better Auth at `/api/auth/**`. To keep users and sessions in D1, add `database: true` and `database: authDatabase()`, and ViteHub adds the tables and their migration. For social sign-in with no database, use the `stateless()` preset.

## What Better Auth, Workers, and D1 are

[Better Auth](https://better-auth.com) is a TypeScript auth framework for sign-in methods, OAuth providers, sessions, and plugins. You put its options in `server/auth.ts`. ViteHub mounts the routes, guards pages, and supplies the signing secret. See [Auth hosts](/docs/auth/hosts) for who owns what.

[Cloudflare Workers](https://developers.cloudflare.com/workers/) runs your server code on Cloudflare. [Cloudflare D1](https://developers.cloudflare.com/d1/) is a SQLite-style database that a Worker reads through a binding. The `cloudflare` host writes the Worker, its `wrangler.json`, and the D1 binding.

## Choose where sessions live

| Storage | Use it when | Limits |
| --- | --- | --- |
| Cloudflare D1 | You need email and password, revocable sessions, or plugins that add tables. | You create the database and apply the generated migration. |
| `stateless()` cookies | Users sign in only with social providers, and there is no database. | You cannot revoke one session. Email and password fails with `AUTH_C0046`. |

::warning
Do not deploy the default Auth setup without one of these. It keeps users and sessions in memory, and a Worker loses them.
::

## Set up Better Auth with D1

### Install the packages

```bash [Terminal]
pnpm add vite-hub @vite-hub/auth @vite-hub/database better-auth drizzle-orm
pnpm add -D drizzle-kit wrangler
```

### Enable Auth and Database

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', auth: true, database: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', auth: true, database: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', auth: true, database: true })],
})
```
:::
::

On the `cloudflare` host, `database: true` picks the D1 driver. `vitehub()` includes the Nitro Vite plugin.

### Connect Better Auth to the database

```ts [server/auth.ts]
import { admin } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'

export default defineAuth({
  appName: 'My app',
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [admin()],
})
```

`authDatabase()` is the Better Auth adapter for the `default` Database, using each request's D1 binding. ViteHub adds these tables: `user`, `session`, `account`, `verification`, the fields of `admin()`, and the `jwks` and `oauth*` tables of [MCP OAuth](/docs/auth/configure#sign-mcp-clients-in). With no Database Definition, ViteHub uses an implicit `default` Database with the D1 binding `DB`. To name the D1 database, add `server/databases/default.ts`, and the Auth tables move into it:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({
  cloudflare: { databaseName: 'my-app-auth' },
  schema: {},
})
```

See [Keep users in the app Database](/docs/auth/configure#keep-users-in-the-app-database) for the tables and options, and [Database configuration](/docs/database/configure) for all Database options.

### Generate the migration

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database migrate
```

`generate` writes the table SQL to `server/databases/default/migrations/`. `migrate` applies it to the local dev SQLite file. `pnpm vitehub inspect definitions --kind database` lists the tables, with `@vite-hub/auth/vite` as their plugin.

## How to run Better Auth locally

In dev, the `cloudflare` host uses the local SQLite file `.vitehub/data/database/sqlite.db` instead of D1. It uses the real D1 database only when the Definition sets `cloudflare.http`. If `VITEHUB_SECRET` is not set, dev generates one in `.vitehub/env/secret`, so sessions survive a restart.

```bash [Terminal]
pnpm dev
```

In another terminal, sign up and read the session back:

```bash [Terminal]
curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
curl -i -b cookies.txt http://localhost:3000/api/auth/get-session
```

The first response is `200` with a `set-cookie` header. The second returns the user and session. Use the port of your `dev` script. [Create your first Auth session](/docs/auth/get-started) explains each request.

## Deploy Better Auth to Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal, then create the D1 database. Provision writes its id to `.vitehub/provision.json`:

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

The build adds the `DB` binding to `.output/server/wrangler.json` and copies the migration SQL next to it. Apply the migrations with Wrangler, then deploy:

```bash [Terminal]
pnpm build
pnpm exec wrangler d1 migrations apply my-app-auth --remote --config .output/server/wrangler.json
pnpm exec nitro deploy --prebuilt
```

Auth signs sessions with a secret derived from `VITEHUB_SECRET`. After the deploy, generate a value of at least 32 characters and store it as a Worker secret:

```bash [Terminal]
pnpm vitehub secret generate
pnpm exec wrangler secret put VITEHUB_SECRET --config .output/server/wrangler.json
```

Auth reads `VITEHUB_SECRET` from each request's Cloudflare bindings. `BETTER_AUTH_SECRET` wins if set. With no secret, Better Auth fails in production. See [App secret](/docs/env/app-secret) and [Cloudflare](/docs/frameworks-hosts/cloudflare).

### Get the first admin

Store the admin's GitHub account as `VITEHUB_ADMINS`, such as `github:22072217`. Find the numeric id with `gh api users/<login> --jq .id`. When that account signs in, it gets the `admin` role of `admin()`:

```bash [Terminal]
pnpm exec wrangler secret put VITEHUB_ADMINS --config .output/server/wrangler.json
```

Then sign in to the app with GitHub. Without GitHub sign-in, run `vitehub auth claim` and store the value it prints as `VITEHUB_ADMIN_CLAIM`. Read [Give the first admin role](/docs/auth/configure#give-the-first-admin-role).

## Use cookie sessions without D1

For social sign-in only, skip the database. `stateless()` keeps each session in an encrypted cookie, so it works across Workers that share the same secret.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare', auth: true,
    env: {
      server: {
        auth: {
          github: {
            clientId: env({ source: env.source('GITHUB_CLIENT_ID') }),
            clientSecret: env({ secret: true, source: env.source('GITHUB_CLIENT_SECRET') }),
          },
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
    host: 'cloudflare',
    auth: true,
    env: {
      server: {
        auth: {
          github: {
            clientId: env({ source: env.source('GITHUB_CLIENT_ID') }),
            clientSecret: env({ secret: true, source: env.source('GITHUB_CLIENT_SECRET') }),
          },
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
    host: 'cloudflare',
    auth: true,
    env: {
      server: {
        auth: {
          github: {
            clientId: env({ source: env.source('GITHUB_CLIENT_ID') }),
            clientSecret: env({ secret: true, source: env.source('GITHUB_CLIENT_SECRET') }),
          },
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

Store `GITHUB_CLIENT_SECRET` and `VITEHUB_SECRET` with `wrangler secret put`. The build lists required secrets in `secrets.required` in `wrangler.json`, and Wrangler stops the deploy if one is missing. See [Sessions without a database](/docs/auth/configure#sessions-without-a-database) for what the host sets and which options fail with it.

## Limits worth knowing

- D1 allows 50 queries per Worker invocation on Workers Free and 1,000 on Workers Paid. A database holds 500 MB on Free and 10 GB on Paid. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Wrangler applies D1 migrations, not `vitehub database migrate`. Run `wrangler d1 migrations apply` after each schema change, before the new Worker gets traffic.
- `session.onRefresh` needs a Better Auth `database` or `secondaryStorage` adapter. With `stateless()`, it fails with `AUTH_C0042`.
- A `stateless()` cookie holds the user and the provider tokens. Large tokens can pass browser or proxy header limits.
- Rotating `VITEHUB_SECRET` signs out every session.

See [Auth limits and errors](/docs/auth/limits-and-errors) for all error codes.

## Move the same Auth to another host

`server/auth.ts` stays the same. Change the host, and the Database uses the new host's storage:

| Host | Database for Better Auth |
| --- | --- |
| `node` | A local SQLite file on the server disk. |
| `vercel` | Hosted libSQL from `database.connection`, or D1 over HTTP with `cloudflare.http`. |

Better Auth can also take a D1 binding directly, but `authDatabase()` keeps one Auth file for D1, local SQLite, libSQL, and Postgres. See [Database hosts](/docs/database/hosts) for each connection.
