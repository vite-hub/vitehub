---
title: Better Auth on Cloudflare Workers and D1 with ViteHub
description: Run Better Auth on Cloudflare Workers from a Vite app with ViteHub. Keep users and sessions in Cloudflare D1, or use cookie sessions with no database.
navigation.title: Better Auth on Cloudflare
navigation.order: 30
navigation.group: Auth
icon: i-simple-icons-betterauth
---

To run Better Auth on Cloudflare Workers, set `preset: 'cloudflare'` and `auth: true` in `vitehub()`, and add `server/auth.ts` with `defineAuth()`. ViteHub mounts Better Auth at `/api/auth/**` in the Worker. To keep users and sessions in Cloudflare D1, add `database: true` and pass Better Auth's Drizzle adapter the client from `useDatabase()`. For social sign-in without a database, use the `stateless()` preset.

## What Better Auth, Workers, and D1 are

[Better Auth](https://better-auth.com) is an authentication framework for TypeScript. It owns sign-in methods, OAuth providers, sessions, and plugins. ViteHub Auth wraps it. One `server/auth.ts` file holds the Better Auth options. ViteHub mounts the routes, guards pages, and supplies the signing secret. See [Auth hosts](/docs/auth/hosts) for what each side owns.

[Cloudflare Workers](https://developers.cloudflare.com/workers/) runs your server code on Cloudflare. [Cloudflare D1](https://developers.cloudflare.com/d1/) is a SQL database with SQLite semantics that a Worker reads through a binding. ViteHub writes the Worker, its `wrangler.json`, and the D1 binding when you build with the `cloudflare` preset.

## Choose where sessions live

| Storage | Use it when | Limits |
| --- | --- | --- |
| Cloudflare D1 | You need email and password, sessions that you can revoke, or Better Auth plugins that add tables. | You create the database and run migrations. |
| `stateless()` cookies | Users sign in only with social providers, and the app has no database. | You cannot revoke one session. Email and password fails with `AUTH_C0046`. |

Do not deploy the default Auth setup without one of these. Its users and sessions are in memory, and a Worker loses them.

## Set up Better Auth with D1

### Install the packages

```bash [Terminal]
pnpm add vite-hub @vite-hub/auth @vite-hub/database better-auth drizzle-orm
pnpm add -D drizzle-kit wrangler
```

### Enable Auth and Database

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', auth: true, database: true })],
})
```

On the `cloudflare` preset, `database: true` selects the D1 driver. `vitehub()` includes the Nitro Vite plugin.

### Add the Better Auth tables

Better Auth needs the `user`, `session`, `account`, and `verification` tables. Write them as Drizzle SQLite tables in `server/databases/schema.ts`, with those export names. Better Auth lists every column in its [core schema](https://better-auth.com/docs/concepts/database#core-schema). Plugins such as `admin()` and `organization()` add more columns and tables. The [Drizzle adapter guide](https://better-auth.com/docs/adapters/drizzle) shows how the Better Auth CLI generates this schema.

Then create the Database Definition. It names the D1 database and uses the tables as its schema:

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'
import * as schema from './schema'

export default defineDatabase({
  cloudflare: { databaseName: 'my-app-auth' },
  schema,
})
```

ViteHub discovers `server/databases/config.ts` as the `default` Database. Its D1 binding is `DB`. Read [Database configuration](/docs/database/configure) for every option.

### Connect Better Auth to the database

```ts [server/auth.ts]
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { defineAuth } from 'vite-hub/auth'
import { useDatabase } from 'vite-hub/database/drizzle'

export default defineAuth(() => {
  const { db, schema } = useDatabase('default')
  return {
    appName: 'My app',
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true },
  }
})
```

ViteHub runs this callback once for each Auth request. `useDatabase('default')` returns the Drizzle client for the D1 binding of that request. Better Auth options stay at the top level of the returned object. See [Auth configuration](/docs/auth/configure).

### Generate the migration

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

`generate` writes the SQL to `server/databases/migrations/`. `migrate` applies it to the local SQLite file that development uses.

## How to run Better Auth locally

On the `cloudflare` preset, the dev server uses a local SQLite file, `.vitehub/data/database/sqlite.db`, in place of the D1 database. It connects to the real D1 database only when the Definition sets `cloudflare.http`. When `VITEHUB_SECRET` is not set, the dev server generates one in `.vitehub/env/secret`, so sessions survive a restart.

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

The first response is `200` with a `set-cookie` header. The second returns the user and the session. Use the port that your `dev` script sets. [Create your first Auth session](/docs/auth/get-started) explains each request.

## Deploy Better Auth to Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. Create the D1 database. Provision writes its id to `.vitehub/provision.json`:

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build the Worker. The build adds the `DB` binding to `.output/server/wrangler.json` and copies the migration SQL beside it. Apply the migrations to the remote database with Wrangler, then deploy:

```bash [Terminal]
pnpm build
pnpm exec wrangler d1 migrations apply my-app-auth --remote --config .output/server/wrangler.json
pnpm exec nitro deploy --prebuilt
```

Auth signs sessions with a secret that it derives from `VITEHUB_SECRET`. After the deploy, generate a value of at least 32 characters and store it as a Worker secret:

```bash [Terminal]
pnpm vitehub secret generate
pnpm exec wrangler secret put VITEHUB_SECRET --config .output/server/wrangler.json
```

Auth reads `VITEHUB_SECRET` from the Cloudflare bindings of each request. A configured `BETTER_AUTH_SECRET` wins over it. Without any secret, Better Auth fails in production. Read [App secret](/docs/env/app-secret) and [Cloudflare](/docs/frameworks-hosts/cloudflare).

Send the same sign-up request to the Worker URL to check the deployment.

## Use cookie sessions without D1

For social sign-in only, skip the database. The `stateless()` preset keeps each session in an encrypted cookie, so it works across Workers when every Worker uses the same secret.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', auth: true })],
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
})
```

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

Store `GITHUB_CLIENT_SECRET` and `VITEHUB_SECRET` as Worker secrets with `wrangler secret put`. The build writes required secret declarations to `secrets.required` in `wrangler.json`, and Wrangler stops the deploy when one of them is missing. Read [Sessions without a database](/docs/auth/configure#sessions-without-a-database) for what the preset sets and which options fail with it.

## Limits worth knowing

- D1 allows 50 queries for each Worker invocation on Workers Free, and 1,000 on Workers Paid. A database can hold 500 MB on Workers Free and 10 GB on Workers Paid. Read [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Wrangler applies D1 migrations, not `vitehub db migrate`. Run `wrangler d1 migrations apply` after each schema change, before the new Worker serves traffic.
- `session.onRefresh` needs a Better Auth `database` or `secondaryStorage` adapter. With `stateless()`, Auth fails with `AUTH_C0042`.
- A `stateless()` session cookie holds the user and the provider tokens. Large provider tokens can exceed browser or proxy header limits.
- Rotating `VITEHUB_SECRET` signs out every session.

Read [Auth limits and errors](/docs/auth/limits-and-errors) for every error code.

## Move the same Auth to another host

`server/auth.ts` and the schema stay the same. Change the preset, and the Database uses the storage of the new host:

| Preset | Database for Better Auth |
| --- | --- |
| `node` | A local SQLite file on the server disk. |
| `vercel` | Hosted libSQL from `database.connection`, or D1 over HTTP with `cloudflare.http`. |

Better Auth can also take a D1 binding directly. The Drizzle adapter path keeps one Auth file for D1, local SQLite, and libSQL. Read [Database hosts](/docs/database/hosts) for each connection.
