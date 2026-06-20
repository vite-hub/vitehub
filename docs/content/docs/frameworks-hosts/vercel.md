---
title: Vercel
description: Generate Vercel Provider Output while preserving ViteHub package boundaries.
navigation.order: 43
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
| Credentials | `VERCEL_TOKEN` and optional team id for Provision; Server Env for app runtime secrets. |

## Configure package options

Select Vercel in the package that owns the primitive.
Do not move provider fields into runtime invocation input when they affect generated output.

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubBlob(),
    hubQueue(),
  ],
  blob: {
    driver: 'vercel',
  },
  queue: {
    provider: 'vercel',
    region: 'iad1',
  },
})
```

## Provision resources

Run a dry run before applying actions.
Use `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` when the token needs a team scope.

```bash [Terminal]
pnpm vitehub provision run --provider vercel --dry-run
VERCEL_TOKEN=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

## Inspect output

Vercel output appears under `.vercel/output`.
Server functions include their own `.vc-config.json`, while the root output config describes routing and build metadata.

```bash [Terminal]
pnpm build
find .vercel/output -maxdepth 4 -type f | sort
```

## Production notes

Vercel provider output should make provider-specific runtime packages reachable only when selected.
If a build bundles an unselected provider dependency, treat that as a Provider Output Contract issue in the owning package.

## Next steps

- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for Provider Selection placement.
- Use [Provider output](/docs/reference/provider-output) for generated Vercel output.
