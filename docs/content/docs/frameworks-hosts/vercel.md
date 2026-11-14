---
title: Vercel
description: Generate Vercel Provider Output while preserving ViteHub package boundaries.
navigation.order: 44
navigation.group: Deployment hosts
icon: i-simple-icons-vercel
---

The `vercel` host deploys your app to Vercel. A production build writes
Vercel Build Output under `.vercel/output`. Definitions stay portable;
Vercel details stay in the config and output.

| Feature | Default on the `vercel` host |
| --- | --- |
| Blob | Vercel Blob with OIDC (`BLOB_STORE_ID`), or `BLOB_READ_WRITE_TOKEN` off Vercel |
| KV | Upstash Redis with `KV_REST_API_URL` and `KV_REST_API_TOKEN` |
| Queue | Vercel Queues |
| Sandbox | Vercel Sandbox |
| Schedule | Vercel Cron Jobs |
| Workflow | Vercel Workflow |
| Rate Limit | None. `rateLimit: true` fails the build. |

## Vercel boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Build Output | `.vercel/output/**` files that package integrations write. |
| Vercel Blob | Blob Store or Workspace Store configuration, by owning primitive. |
| Vercel Queues | Queue provider config and generated callback output. |
| Vercel Workflow | Workflow provider config and generated runtime output. |
| Vercel Sandbox | Sandbox Provider config. Sandbox Identity only when a run reuses a sandbox. |
| External Database | A Database Definition on Cloudflare D1 over authenticated HTTP, or a Database integration `connection` to hosted libSQL. |
| Credentials | `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`, plus an optional team id, for Blob Provision. Server Env for runtime secrets. |

## Configure the host

Select the `vercel` host and turn on the features you use.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    blob: true,
    queue: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      blob: true,
      queue: true,
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      blob: true,
      queue: true,
    }),
  ],
})
```
:::
::

::warning
State on Vercel needs hosted stores. For Blob, use `driver: 'vercel-blob'` with a connected store (`BLOB_STORE_ID`). For KV, use Upstash with `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or set `kv: { driver: 'redis' }` for a Redis at `REDIS_URL`. Local filesystem stores work only in development.
::

Database Definitions own tables and identity. The Database integration selects the hosted connection for Vercel output. Declare Marketplace credentials as Runtime Env so the output reads them at runtime.

A Definition uses Cloudflare D1 from Vercel only when it declares `cloudflare.http`. Set it to `true` for Cloudflare's D1 raw API, and set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as Vercel Server Env. Cloudflare deployments still prefer the D1 binding.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
    http: true,
  },
  schema: { notes },
})
```

For steady app traffic, Cloudflare recommends a proxy Worker, because the D1 REST API is for admin use and shares the global Cloudflare API rate limit. Set `cloudflare.http` to `{ url, authToken }` for an authenticated, raw-compatible HTTP(S) proxy. Without `cloudflare.http`, the Definition keeps hosted libSQL, even with a D1 database id.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    database: {
      connection: {
        url: env({ source: env.source('TURSO_DATABASE_URL') }),
        authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
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
  plugins: [
    vitehub({
      host: 'vercel',
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
      },
    }),
  ],
})
```
:::
::

## Provision boundary

Provision shows a dry-run plan before it applies actions. `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` gives the team scope when the token needs it.

```bash [Terminal]
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

## Generated output

Output goes to `.vercel/output`. Each server function has its own `.vc-config.json`. The root config describes routing and build metadata.

```bash [Terminal]
pnpm build
find .vercel/output -maxdepth 4 -type f | sort
```

## Production notes

The output bundles a provider's runtime package only when you select it. If it bundles an unselected one, that is a Provider Output Contract bug in the owning package.

Agent Definitions run through generated output when the Agent integration owns the route. Keep model keys, state credentials, and other Runtime Env in Vercel environment variables.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for Provider Selection placement.
- Use [Provider output](/docs/reference/provider-output) for generated Vercel output.

## Related guides

For provider setup and checks, see [Deploy an Agent](/docs/guides/deploy-agent-cloudflare-vercel),
[private Blob storage](/docs/guides/vercel-blob),
[Upstash KV](/docs/guides/upstash-redis), or [Turso](/docs/guides/turso).
