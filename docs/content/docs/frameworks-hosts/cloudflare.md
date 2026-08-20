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
| D1, R2, KV, Queues, Browser Run, Rate Limiting bindings, Workflows, and Sandbox resources | Primitive package configuration plus Provision Steps where available. |
| Credentials | Provider env vars for provisioning or host runtime secrets through Server Env. |
| Runtime context | Runtime Host Context passed by the host integration, not app-owned global state. |
| Agent state | Agent Package state provider configuration when Cloudflare-backed state is selected. |
| Cloudflare Computer Boxes | App-owned Computer Durable Object, backend, bindings, migrations, and compatibility flags; ViteHub adapts the configured namespace at runtime. |

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
  queue: {
    provider: 'cloudflare',
    binding: 'JOBS',
  },
})
```

Database D1 metadata belongs to each Database Definition because a Vite app can have multiple Named Databases.

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    binding: 'DB',
    databaseName: 'app',
  },
  schema: { notes },
})
```

The Nuxt-only `database.driver: 'd1'` option configures one Nuxt Content and Nitro host resource; it is not a Vite Database Definition shortcut.

## Provision boundary

Provision exposes a dry-run plan before it applies changes. A successful apply writes non-secret ids into `.vitehub/provision.json`; secrets remain in environment variables or provider env stores.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
```

## Generated output

Cloudflare output can include worker bundles, `wrangler.json`, D1 bindings, queue consumers, Rate Limiting bindings, cron triggers, and package-specific runtime imports. A production-shaped build materialises the selected output under `dist`.

```bash [Terminal]
pnpm build
find dist -maxdepth 4 -type f | sort
```

Agent routes should come from generated Provider Output. Raw Cloudflare Worker fetch handlers are not a public Agent API.

Required secret Server Env declarations with one exact Env Source are written to `secrets.required` in the generated Wrangler configuration, including each configured named Wrangler environment because secrets are not inherited. Wrangler reuses an existing Worker secret and stops deployment when that binding is absent; ViteHub records only the binding name and never resolves or writes its value during build. Optional secrets, non-secret values, defaults, and alternative source lists remain runtime-only because Wrangler's required list cannot express fallback names.

### Workers Builds

Use Nitro's generated deployment command for production and non-production Workers Builds:

```bash [Deploy command]
pnpm exec nitro deploy --prebuilt
```

When Sandbox is enabled, ViteHub writes an explicit gradual Container rollout into `.output/nitro.json`. This deploys the Worker and its Container application through the same generated contract. A direct Wrangler command with `--containers-rollout=none` bypasses ViteHub's deployment command and can leave a newly scoped Sandbox binding without a Container application to run.

### Rate Limiting bindings

Register the Rate Limit integration. A Cloudflare Nitro preset infers the provider, and each handler-local `requireRateLimit()` policy contributes one `ratelimits` entry to Nitro's Wrangler config. Do not repeat those bindings in `nitro.cloudflare.wrangler`; plain Vite builds continue to write them to generated `wrangler.json`.

```ts [vite.config.ts]
import { hubRateLimit } from '@vite-hub/rate-limit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubRateLimit({ namespace: 'acme-image-service-production' })],
})
```

Cloudflare native enforcement is best-effort and supports 10-second or 60-second fixed windows. The integration rejects `enforcement: 'strict'` and unsupported periods during the build instead of silently weakening the policy. Its inspectable capabilities report location-scoped counters, unknown rejected-attempt behavior, and `availability: 'never'` for every quota metadata field; the binding returns only an allow-or-reject decision.

The generated binding is request-scoped. If it is unavailable at runtime, the handle's `failure` policy decides whether the request is denied or allowed. Give every separately deployed Worker and environment a unique namespace because Cloudflare shares counters with the same namespace ID across Workers in one account. Rate Limiting bindings do not use Cloudflare KV and require no separate resource provisioning.

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

### Browser Run bindings

Register the Browser integration when trusted server code needs Cloudflare Browser Run sessions.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      browser: true,
    }),
  ],
})
```

ViteHub writes the generated `browser` binding plus the `nodejs_compat` and `no_websocket_standard_binary_type` flags, then uses Kitesurf by default. Browser Definitions import runtime helpers from `vite-hub/browser`; provider modules and the generated `wrangler.json` are not application import surfaces.

`wrangler dev` can run Browser Run against a local browser. Set `browser: { remote: true }` to keep Worker code local while connecting its Browser binding to Cloudflare, which is useful when a proof must exercise the hosted Browser Run service.

### Cloudflare Computer Boxes

Cloudflare Computer is an optional preview runtime for [Boxes](/docs/agents/boxes#choose-a-runtime). The application owns its `withWorkspace()` Durable Object, execution backends, Worker Loader or Container bindings, migrations, compatibility flags, and deployment lifecycle. ViteHub accepts that configured Durable Object namespace through `{ kind: 'cloudflare-computer' }`; current Provider Output does not create or modify Computer infrastructure.

Keep the Computer filesystem and backend configuration at the Cloudflare boundary. Agent definitions should declare Box inputs and select a registered backend ID without importing Computer filesystem or execution APIs.

## Production notes

Cloudflare local development and deployed Workers do not always expose the same runtime behavior.
Use Provider Output Contracts and Local Provider Runs for pull request checks, then keep Live Smoke thin against real Cloudflare deployments.

::warning
Cloudflare Provider Output can require real Worker bindings such as D1, R2, KV, Rate Limiting, Queues, Durable Objects, Cloudflare Artifacts, or Agent state. Verify generated bindings before deploy, then smoke test the deployed Worker when runtime bindings matter.
::

Agent Definitions run on Cloudflare through generated host output where the Agent integration owns the route. Keep model keys, Durable Object state bindings, and other Runtime Env in Worker bindings.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for resource creation.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Verification](/docs/development/verification) for Cloudflare proof tiers.
