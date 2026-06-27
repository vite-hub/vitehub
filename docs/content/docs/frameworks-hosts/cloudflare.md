---
title: Cloudflare
description: Configure Cloudflare Provider Output while keeping ViteHub Definitions and Runtime Helpers host-neutral.
navigation.order: 42
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

## Configure provider-owned primitives

Use the primitive package options to select Cloudflare.
The exact option belongs to the package that owns the primitive.

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

## Provision missing resources

Preview before applying.
Provision writes non-secret ids into `.vitehub/provision.json`; secrets remain in environment variables or provider env stores.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
```

## Inspect output

Cloudflare output can include worker bundles, `wrangler.json`, D1 bindings, queue consumers, cron triggers, and package-specific runtime imports.
Inspect output after a production-shaped build.

```bash [Terminal]
pnpm build
find dist -maxdepth 4 -type f | sort
```

Agent-only Vite apps are different in 0.0.2. `VITEHUB_HOSTING=cloudflare pnpm build` writes generated Agent route source under `.vitehub/agent`, but it does not emit a Worker bundle or `wrangler.json`. For a Cloudflare Worker entry, use the public Agent Package handler.

```ts [worker.ts]
import { defineCloudflareAgentHandler } from '@vite-hub/agent/cloudflare'
import echo from './server/agents/echo/config'

export default {
  fetch: defineCloudflareAgentHandler(echo),
}
```

## Production notes

Cloudflare local development and deployed Workers do not always expose the same runtime behavior.
Use Provider Output Contracts and Local Provider Runs for pull request checks, then keep Live Smoke thin against real Cloudflare deployments.

::warning
Cloudflare Provider Output can require real Worker bindings such as D1, R2, KV, Queues, Durable Objects, Cloudflare Artifacts, or Agent state. Verify generated bindings before deploy, then smoke test the deployed Worker when runtime bindings matter.
::

Agent Definitions can run on Cloudflare through the Agent Package's Cloudflare handler, or through generated host output where the Agent integration owns that route. Keep model keys, Durable Object state bindings, and other Runtime Env in Worker bindings.

## Next steps

- Use [Provisioning](/docs/development/provisioning) for resource creation.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Verification](/docs/development/verification) for Cloudflare proof tiers.
