---
title: Vercel
description: Generate Vercel Provider Output while preserving ViteHub package boundaries.
navigation.order: 44
icon: i-simple-icons-vercel
---

Vercel is a Provider Selection for packages that can emit Vercel Build Output, functions, queues, workflows, blob-backed storage, or sandbox integration.
ViteHub keeps Definitions portable and moves Vercel-specific behavior into package Integration Options and Provider Output.

## Vercel boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Build Output | Generated `.vercel/output/**` files written by package integrations. |
| Vercel Blob | Blob Store or Workspace Store configuration, depending on which primitive owns the behavior. |
| Vercel Queues | Queue provider configuration and generated callback output. |
| Vercel Workflow | Workflow provider configuration and generated runtime output. |
| Vercel Sandbox | Sandbox Provider configuration, with Sandbox Identity passed only when the run needs reuse. |
| External Database | A Database Definition backed by Cloudflare D1 over authenticated HTTP, or Database integration `connection` backed by hosted libSQL. |
| Credentials | `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` for Blob Provision, with an optional team id; Server Env for app runtime secrets. |

## Provider-owned configuration

Select the Vercel preset in the framework integration. Each primitive still owns its Definitions and Runtime Helpers.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: true,
      queue: true,
    }),
    nitro() as never,
  ],
})
```

::warning
Vercel-hosted state needs hosted stores. Use `driver: 'vercel-blob'` with `BLOB_READ_WRITE_TOKEN` for Blob, and use Upstash-backed KV with `KV_REST_API_URL` and `KV_REST_API_TOKEN` when KV runs on Vercel. Local filesystem stores are development-only in Vercel deployments.
::

Database Definitions own tables and identity, while the Database Integration selects the hosted connection used by Vercel output. Use Runtime Env declarations for Marketplace-provisioned credentials so generated output reads them at runtime.

A Definition uses Cloudflare D1 from Vercel only when it declares `cloudflare.http`. Set it to `true` for Cloudflare's D1 raw API, then configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as Vercel Server Env. Cloudflare deployments still prefer the D1 binding.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'

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

For sustained application traffic, Cloudflare recommends a proxy Worker because its built-in D1 REST API is intended primarily for administrative use and shares the global Cloudflare API rate limit. Set `cloudflare.http` to `{ url, authToken }` for an authenticated raw-compatible HTTP(S) proxy. Omitting `cloudflare.http` preserves the hosted libSQL selection even when the Definition includes a D1 database id.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
      },
    }),
    nitro() as never,
  ],
})
```

## Provision boundary

Provision exposes a dry-run plan before applying actions. `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` supplies team scope when the token requires it.

```bash [Terminal]
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

## Generated output

Vercel output appears under `.vercel/output`. Server functions include their own `.vc-config.json`, while the root output config describes routing and build metadata.

```bash [Terminal]
pnpm build
find .vercel/output -maxdepth 4 -type f | sort
```

## Production notes

Vercel provider output makes provider-specific runtime packages reachable only when selected.
If a build bundles an unselected provider dependency, treat that as a Provider Output Contract issue in the owning package.

Agent Definitions run on Vercel through generated host output where the Agent integration owns the route. Keep model keys, state credentials, and other Runtime Env in Vercel environment variables.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for Provider Selection placement.
- Use [Provider output](/docs/reference/provider-output) for generated Vercel output.
