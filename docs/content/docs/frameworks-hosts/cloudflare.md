---
title: Cloudflare
description: Configure Cloudflare Provider Output while keeping ViteHub Definitions and Runtime Helpers host-neutral.
navigation.order: 43
icon: i-simple-icons-cloudflare
---

Cloudflare is a Provider Selection for packages that can generate Workers, bindings, queues, workflows, schedules, storage, or sandbox output.
The Definition and Runtime Helper should stay host-neutral; Cloudflare details belong in Integration Options and Provider Output.

## Cloudflare boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Workers and generated bundles | Provider Output written during production-shaped builds. |
| D1, R2, KV, Queues, Workflows, and Sandbox resources | Primitive package configuration plus Provision Steps where available. |
| Credentials | Provider env vars for provisioning or host runtime secrets through Server Env. |
| Runtime context | Runtime Host Context passed by the host integration, not app-owned global state. |
| Agent state | Agent Package state provider configuration when Cloudflare-backed state is selected. |

## Provider-owned configuration

The primitive package options select Cloudflare. Each provider field stays with the package that owns the primitive.

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubDb(),
    hubQueue(),
  ],
  database: {
    driver: 'd1',
    binding: 'DB',
    databaseName: 'app',
  },
  queue: {
    provider: 'cloudflare',
    binding: 'JOBS',
  },
})
```

## Provision boundary

Provision exposes a dry-run plan before it applies changes. A successful apply writes non-secret ids into `.vitehub/provision.json`; secrets remain in environment variables or provider env stores.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
```

## Generated output

Cloudflare output can include worker bundles, `wrangler.json`, D1 bindings, queue consumers, cron triggers, and package-specific runtime imports. A production-shaped build materialises the selected output under `dist`.

```bash [Terminal]
pnpm build
find dist -maxdepth 4 -type f | sort
```

Agent routes should come from generated Provider Output. Raw Cloudflare Worker fetch handlers are not a public Agent API.

Workspace adds an Artifacts binding when its Store explicitly selects Cloudflare Artifacts:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {
    store: {
      provider: 'cloudflare-artifacts',
      binding: 'WORKSPACE_ARTIFACTS',
      namespace: 'vitehub',
    },
  },
})
```

Inspect the generated `artifacts` entry in `wrangler.json` before deployment. Workspace preserves unrelated app-owned Artifacts bindings. Cloudflare hosting still defaults to the ephemeral `memory` Store because Artifacts requires explicit beta access.

## Production notes

Cloudflare local development and deployed Workers do not always expose the same runtime behavior.
Use Provider Output Contracts and Local Provider Runs for pull request checks, then keep Live Smoke thin against real Cloudflare deployments.

::warning
Cloudflare Provider Output can require real Worker bindings such as D1, R2, KV, Queues, Durable Objects, Cloudflare Artifacts, or Agent state. Verify generated bindings before deploy, then smoke test the deployed Worker when runtime bindings matter.
::

Agent Definitions run on Cloudflare through generated host output where the Agent integration owns the route. Keep model keys, Durable Object state bindings, and other Runtime Env in Worker bindings.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for resource creation.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Verification](/docs/development/verification) for Cloudflare proof tiers.
