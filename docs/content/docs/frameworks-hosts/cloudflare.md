---
title: Cloudflare
description: Configure Cloudflare Provider Output while keeping ViteHub Definitions and Runtime Helpers host-neutral.
navigation.order: 43
navigation.group: Deployment hosts
icon: i-simple-icons-cloudflare
---

Use the `cloudflare` preset to deploy a ViteHub application as a Cloudflare
Worker. A production build writes the Worker and its `wrangler.json` under
`.output/server`, with the bindings that the enabled features need. Definitions
and Runtime Helpers stay host-neutral; Cloudflare details stay in the config and
the generated output.

| Feature | Default on the `cloudflare` preset |
| --- | --- |
| Blob | R2 bucket named after the application |
| KV | Workers KV binding `KV` |
| Database | D1 binding from the Database Definition |
| Queue | Cloudflare Queues with an application name prefix |
| Rate Limit | Rate Limiting binding with the application name as namespace |
| Sandbox | Cloudflare Sandbox |
| Workflow | Cloudflare Workflows |
| Workspace | `memory` Store unless you select Cloudflare Artifacts |
| Browser and `email: true` | Browser Run and Cloudflare Email. Both require this preset. |

The application name comes from `vitehub({ name })`, then
`WRANGLER_CI_OVERRIDE_NAME` in Workers Builds, then the `package.json` name.
It also becomes the Worker name unless `nitro.cloudflare.wrangler.name` is set.

## Cloudflare boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Workers and generated bundles | Provider Output written during production-shaped builds. |
| D1, R2, KV, Queues, Browser Run, Rate Limiting bindings, Workflows, and Sandbox resources | Primitive package configuration plus Provision Steps where available. |
| Credentials | Provider env vars for provisioning or host runtime secrets through Server Env. |
| Runtime context | Runtime Host Context passed by the host integration, not app-owned global state. |
| Agent state | Agent Package state provider configuration when Cloudflare-backed state is selected. |

## Configure the preset

Select the `cloudflare` preset and enable the features the application uses.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      database: true,
      queue: true,
    }),
  ],
})
```

Database D1 metadata belongs to each Database Definition because a Vite app can have multiple Named Databases.

```ts [src/database.ts]
import { defineDatabase } from 'vite-hub/database'
import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    binding: 'DB',
    databaseId: '00000000-0000-0000-0000-000000000001',
    databaseName: 'app',
  },
  schema: { notes },
})
```

The Nuxt-only `database.driver: 'd1'` option configures one Nuxt Content and Nitro host resource; it is not a Vite Database Definition shortcut.

When the Console is enabled with Agents, a Cloudflare build stores the Console invocation journal in this D1 binding. The journal creates its `vitehub_agent_invocations` table on first use. See [Cloudflare journal](/docs/development/console#know-what-the-console-stores).

## Provision boundary

Provision exposes a dry-run plan before it applies changes. A successful apply writes non-secret ids into `.vitehub/provision.json`; secrets remain in environment variables or provider env stores.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
```

## Generated output

Cloudflare output can include worker bundles, `wrangler.json`, D1 bindings, queue consumers, Rate Limiting bindings, cron triggers, and package-specific runtime imports. The Cloudflare preset materialises its deployment artifact under `.output/server`.

In Nuxt, the preset enables Nitro's `cloudflare.deployConfig` by default so a
local production build emits `.output/server/wrangler.json`. An explicit
`nitro.cloudflare.deployConfig: false` disables that file.

```bash [Terminal]
pnpm build
test -f .output/server/wrangler.json
find .output -maxdepth 4 -type f | sort
```

### A project Wrangler config

A project `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` can declare bindings that ViteHub also writes, for example a Deploy to Cloudflare template. Nitro merges that file into the generated config by concatenating arrays. ViteHub then keeps one entry per name in `kv_namespaces`, `r2_buckets`, `ratelimits`, `hyperdrive`, `containers` (by `class_name`), `durable_objects.bindings`, `migrations`, `queues`, `workflows`, `services`, `send_email`, and `analytics_engine_datasets`, at the top level and in each `env`. The Database integration does the same for `d1_databases`, see [Database hosts](/docs/database/hosts). It also removes repeated `compatibility_flags` and `secrets.required` names.

ViteHub's entry wins, and the project entry fills fields it lacks, such as a KV `id`. An all-zero id, such as `00000000000000000000000000000000` or `00000000-0000-4000-8000-000000000000`, never names a resource: a real id from either side replaces it. An id that stays all-zero is left out for KV and D1, so Wrangler provisions the resource on deploy. Hyperdrive requires an existing resource: its unresolved placeholder is preserved, and you must replace it with a real Hyperdrive ID before deployment. When the two entries name a different resource, the build fails with `INTERNAL_B0051`. Remove the entry from the project file, or give one of them another name.

### Node.js compatibility in Nuxt

With Nitro's `cloudflare.nodeCompat`, which the Nuxt `cloudflare` preset turns on, the generated `wrangler.json` gets `nodejs_compat`. Nitro 2 adds `no_nodejs_compat_v2` next to it unless the config names `nodejs_compat_v2`, and that leaves out Node modules that Workspaces import. ViteHub sets `nodejs_compat_v2` while Nitro builds and writes `nodejs_compat` in its place once the file is written, after the project's `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` was merged in. Wrangler refuses the two flags together.

When the app names `nodejs_compat_v2` or `no_nodejs_compat_v2` in `nitro.cloudflare.wrangler.compatibility_flags` or in its project Wrangler config, ViteHub leaves the flags as the app wrote them. `nodejs_compat_v2` alone provides `node:http` and `node:child_process` only from compatibility date 2026-08-04.

An explicit `no_nodejs_compat` in either configuration disables Nitro's `cloudflare.nodeCompat` and skips ViteHub's flag rewrite, preserving the app's full Node.js compatibility opt-out.

Check the output before deploying. `wrangler deploy --dry-run` validates the config, and `wrangler dev` starts the Worker, which catches a Node module that the date and flags leave out:

```bash [Terminal]
pnpm build
pnpm wrangler deploy --dry-run
pnpm wrangler dev
```

Generate Agent routes through Provider Output. Raw Cloudflare Worker fetch handlers are not a public Agent API.

Required secret Server Env declarations with one exact Env Source are written to `secrets.required` in the generated Wrangler configuration, including each configured named Wrangler environment because secrets are not inherited. Wrangler reuses an existing Worker secret and stops deployment when that binding is absent; ViteHub records only the binding name and never resolves or writes its value during build. Optional secrets, non-secret values, defaults, and alternative source lists remain runtime-only because Wrangler's required list cannot express fallback names.

### Workers Builds

Use Nitro's generated deployment command for production and non-production Workers Builds:

```bash [Deploy command]
pnpm exec nitro deploy --prebuilt
```

When Sandbox is enabled, ViteHub writes an explicit gradual Container rollout into `.output/nitro.json`. This deploys the Worker and its Container application through the same generated contract. A direct Wrangler command with `--containers-rollout=none` bypasses ViteHub's deployment command and can leave a newly scoped Sandbox binding without a Container application to run.

### Rate Limiting bindings

With `vitehub({ preset: 'cloudflare', rateLimit: true })`, ViteHub selects the Cloudflare provider and uses the application name as the namespace. Each handler-local `requireRateLimit()` policy contributes one `ratelimits` entry to Nitro's Wrangler config. Do not repeat those bindings in `nitro.cloudflare.wrangler`.

When you compose the owner integration directly, add the Nitro plugin with a Cloudflare preset and set the namespace yourself. The preset selects the Cloudflare provider. Nitro writes the bindings to the generated `wrangler.json`.

```ts [vite.config.ts]
import { hubRateLimit } from '@vite-hub/rate-limit/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  nitro: { preset: 'cloudflare-module' },
  plugins: [
    hubRateLimit({ namespace: 'acme-image-service-production' }),
    nitro(),
  ],
})
```

Cloudflare native enforcement is best-effort and supports 10-second or 60-second fixed windows. The integration rejects `enforcement: 'strict'` and unsupported periods during the build instead of silently weakening the policy. Its inspectable capabilities report location-scoped counters, unknown rejected-attempt behavior, and `availability: 'never'` for every quota metadata field; the binding returns only an allow-or-reject decision.

The generated binding is request-scoped. If it is unavailable at runtime, the handle's `failure` policy decides whether the request is denied or allowed. Give every separately deployed Worker and environment a unique namespace because Cloudflare shares counters with the same namespace ID across Workers in one account. Rate Limiting bindings do not use Cloudflare KV and require no separate resource provisioning.

Workspace adds an Artifacts binding when its Store explicitly selects Cloudflare Artifacts:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'

export default {
  plugins: [
    hubWorkspace({
      store: {
        provider: 'cloudflare-artifacts',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
      },
    }),
  ],
}
```

Inspect the generated `artifacts` entry in `wrangler.json` before deployment. Workspace preserves unrelated app-owned Artifacts bindings. Cloudflare hosting still defaults to the ephemeral `memory` Store because Artifacts requires explicit beta access.

### Browser Run bindings

Register the Browser integration when trusted server code needs Cloudflare Browser Run sessions.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({
    preset: 'cloudflare',
    browser: true,
  }),
}
```

ViteHub writes the generated `browser` binding, a compatible default `compatibility_date`, and the `nodejs_compat` flag. Browser Definitions import runtime helpers from `vite-hub/browser`; provider modules and the generated `wrangler.json` are not application import surfaces.

`wrangler dev` can run Browser Run against a local browser. Set `browser: { remote: true }` to keep Worker code local while connecting its Browser binding to Cloudflare, which is useful when a proof must exercise the hosted Browser Run service.

## Production notes

Cloudflare local development and deployed Workers do not always expose the same runtime behavior.
Use Provider Output Contracts and Local Provider Runs for pull request checks, then keep Live Smoke thin against real Cloudflare deployments.

::warning
Cloudflare Provider Output can require real Worker bindings such as D1, R2, KV, Rate Limiting, Queues, Durable Objects, Cloudflare Artifacts, or Agent state. Verify generated bindings before deploy, then smoke test the deployed Worker when runtime bindings matter.
::

Agent Definitions run on Cloudflare through generated host output where the Agent integration owns the route. Keep model keys, Durable Object state bindings, and other Runtime Env in Worker bindings.

### Console on Workers

Cloudflare can send consecutive requests from one browser to different Worker instances. The [Console](/docs/development/console) sends each operation as one stateless `POST /_vitehub/rpc/__call` request, so it does not need session affinity or in-memory state. With a session-based `auth`, the access policy checks the session cookie on each call. Agent invocations started from the Console pass background work to the Worker's `waitUntil`. Configure a durable hosted invocation journal, as the [Console guide](/docs/development/console) describes.

Protect a production Console with `console: { auth: { provider: 'cloudflare-access' } }` and a Cloudflare Access application. The Worker verifies the Access token on each Console request with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. Inline GitHub Console Auth needs `node:sqlite` and is not available on Workers. See [Protect the Console route](/docs/development/console#protect-the-console-route).

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for resource creation.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Verification](/docs/development/verification) for Cloudflare proof tiers.

## Related guides

Use [Deploy an Agent](/docs/guides/deploy-agent-cloudflare-vercel),
[D1 with Drizzle](/docs/guides/cloudflare-d1),
[R2 file storage](/docs/guides/cloudflare-r2), or
[Browser Run](/docs/guides/cloudflare-browser) for worked deployment tasks.
