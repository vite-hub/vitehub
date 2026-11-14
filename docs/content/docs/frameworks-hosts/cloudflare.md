---
title: Cloudflare
description: Configure Cloudflare Provider Output while keeping ViteHub Definitions and Runtime Helpers host-neutral.
navigation.order: 43
navigation.group: Deployment hosts
icon: i-simple-icons-cloudflare
---

The `cloudflare` host deploys your app as a Cloudflare Worker. A production
build writes the Worker and its `wrangler.json`, with the bindings your
features need, under `.output/server`. Definitions and Runtime Helpers stay
host-neutral. Cloudflare details stay in the config and generated output.

| Feature | Default on the `cloudflare` host |
| --- | --- |
| Blob | R2 bucket named after the app |
| KV | Workers KV binding `KV` |
| Database | D1 binding from the Database Definition |
| Queue | Cloudflare Queues with the app name as prefix |
| Rate Limit | Rate Limiting binding with the app name as namespace |
| Sandbox | Cloudflare Sandbox |
| Workflow | Cloudflare Workflows |
| Workspace | `memory` Store unless you select Cloudflare Artifacts |
| Browser and `email: true` | Browser Run and Cloudflare Email. Both require this host. |

The app name comes from `vitehub({ name })`, then `WRANGLER_CI_OVERRIDE_NAME`
in Workers Builds, then the `package.json` name. It is also the Worker name
unless `nitro.cloudflare.wrangler.name` is set.

## Cloudflare boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Workers and generated bundles | Provider Output (generated host files) from production builds. |
| D1, R2, KV, Queues, Browser Run, Rate Limiting bindings, Workflows, and Sandbox resources | Primitive package configuration, plus Provision Steps where available. |
| Credentials | Provider env vars for provisioning, or runtime secrets through Server Env. |
| Runtime context | Runtime Host Context from the host integration, not global app state. |
| Agent state | Agent state provider configuration when you select Cloudflare state. |

## Configure the host

Select the `cloudflare` host and turn on the features you use.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    database: true,
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
      host: 'cloudflare',
      database: true,
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
      host: 'cloudflare',
      database: true,
      queue: true,
    }),
  ],
})
```
:::
::

D1 metadata belongs to each Database Definition, because a Vite app can have several Named Databases.

```ts [src/database.ts] fragment
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

The Nuxt-only `database.driver: 'd1'` option sets up one host resource for Nuxt Content and Nitro. It is not a shortcut for a Vite Database Definition.

With the Console and Agents on, a Cloudflare build stores the Console run journal in this D1 binding. The journal creates its `vitehub_agent_invocations` table on first use. See [Cloudflare journal](/docs/development/console#know-what-the-console-stores).

## Provision boundary

Provision shows a dry-run plan before it applies changes. A successful apply writes non-secret ids to `.vitehub/provision.json`. Secrets stay in environment variables or provider env stores.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
```

## Generated output

`.output/server` can hold Worker bundles, `wrangler.json`, D1 bindings, queue consumers, Rate Limiting bindings, cron triggers, and package runtime imports.

In Nuxt, the host turns on Nitro's `cloudflare.deployConfig` by default, so a
local production build writes `.output/server/wrangler.json`.
`nitro.cloudflare.deployConfig: false` turns that file off.

```bash [Terminal]
pnpm build
test -f .output/server/wrangler.json
find .output -maxdepth 4 -type f | sort
```

### A project Wrangler config

A project `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` can declare bindings that ViteHub also writes, for example in a Deploy to Cloudflare template. Nitro merges that file into the generated config and joins the arrays. ViteHub then keeps one entry per name in `kv_namespaces`, `r2_buckets`, `ratelimits`, `hyperdrive`, `containers` (by matching `class_name` or `name`, with entries containing both linking the two forms), `durable_objects.bindings`, `migrations`, `queues`, `workflows`, `services`, `send_email`, and `analytics_engine_datasets`, at the top level and in each `env`. The Database integration does the same for `d1_databases`; see [Database hosts](/docs/database/hosts). It also removes repeated `compatibility_flags` and `secrets.required` names.

- ViteHub's entry wins. The project entry fills fields it lacks, such as a KV `id`.
- An all-zero id, such as `00000000000000000000000000000000` or `00000000-0000-4000-8000-000000000000`, never names a resource. A real id from either side replaces it.
- For KV and D1, a primary id that stays all-zero is left out, so Wrangler provisions the resource on deploy.
- Unresolved `preview_id` and `preview_database_id` placeholders stay, so remote development cannot fall back to production. Replace them with real preview ids first.
- Hyperdrive needs an existing resource. Replace its placeholder with a real Hyperdrive id before you deploy.
- Two entries that name different resources fail the build with `INTERNAL_B0051`. Remove the project entry, or rename one.

Container duplicates must agree on `scheduling_policy`, which defaults to `default`. ViteHub rejects a policy change or conflicting image settings. It does not combine the default policy's `image` with Durable Object-managed `images`.

### Node.js compatibility in Nuxt

With Nitro's `cloudflare.nodeCompat`, which the Nuxt `cloudflare` preset turns on, Nitro adds `nodejs_compat` to the generated `wrangler.json` for compatibility dates before 2026-08-04. From that date, Workers turn it on by default. ViteHub leaves the flags as the app wrote them in `nitro.cloudflare.wrangler.compatibility_flags` or in its project Wrangler config.

An explicit `no_nodejs_compat` in either configuration disables Nitro's `cloudflare.nodeCompat`, preserving the app's full Node.js compatibility opt-out.

Check the output before you deploy. `wrangler deploy --dry-run` validates the config. `wrangler dev` starts the Worker and catches a Node module that the date and flags leave out:

```bash [Terminal]
pnpm build
pnpm wrangler deploy --dry-run
pnpm wrangler dev
```

Agent routes come from Provider Output. Raw Worker fetch handlers are not a public Agent API.

A required secret Server Env declaration with one exact Env Source goes to `secrets.required` in the Wrangler config, and to each named Wrangler environment, since they do not inherit secrets. Wrangler reuses an existing Worker secret and stops the deploy when it is missing. ViteHub records only the name, never the value. Optional secrets, non-secret values, defaults, and fallback source lists stay runtime-only, because Wrangler's list cannot express fallbacks.

### Workers Builds

Use Nitro's generated deploy command for production and non-production Workers Builds:

```bash [Deploy command]
pnpm exec nitro deploy --prebuilt
```

With deploy config generation on (the default), ViteHub writes the command to `.output/nitro.json` as `wrangler deploy --config` with the generated `.output/server/wrangler.json`. It works from a copy of `.output` alone and inside a workspace with its own Wrangler config. Set `nitro.commands.deploy` to use your own. With `nitro.cloudflare.deployConfig: false`, ViteHub keeps Nitro's default command. With `database: { migrateOnDeploy: true }`, the command applies the pending D1 migrations before `wrangler deploy`, and stops when one fails. See [Migrate when you deploy](/docs/database/configure#migrate-when-you-deploy).

With config generation and Sandbox on, ViteHub writes an explicit gradual Container rollout to `.output/nitro.json`, so the Worker and its Container application deploy together.

::warning
A direct Wrangler command with `--containers-rollout=none` skips ViteHub's deploy command. It can leave a new Sandbox binding without a Container application to run.
::

### Upload secrets from a file

A new Worker has no secrets yet, so `wrangler secret put` cannot set the values `secrets.required` asks for. To upload them when you deploy from your terminal, name a `.env` or JSON file:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    cloudflare: { secretsFile: '.env' },
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
      host: 'cloudflare',
      cloudflare: { secretsFile: '.env' },
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
      host: 'cloudflare',
      cloudflare: { secretsFile: '.env' },
    }),
  ],
})
```
:::
::

When the file exists at build time, ViteHub adds `--secrets-file` with its path to the deploy command in `.output/nitro.json`. `nitro deploy --prebuilt` then uploads every key in the file as a Worker secret.

- Wrangler keeps secrets that the file does not name.
- The path is relative to the project root. The command finds it from the project root or from `.output`.
- ViteHub only checks that the file exists. It never reads or copies the values.
- A build without the file, such as Workers Builds or Deploy to Cloudflare, writes the command without the flag. The secrets you set in the dashboard stay in use.
- The option needs Wrangler 4.74 or later. Your own `nitro.commands.deploy` replaces it, and it does nothing with `nitro.cloudflare.deployConfig: false`.

::warning
Do not build with a local secrets file and deploy that `.output` from another machine.
::

### Rate Limiting bindings

With `vitehub({ host: 'cloudflare', rateLimit: true })`, ViteHub selects the Cloudflare provider and uses the app name as the namespace. Each `requireRateLimit()` policy in a handler adds one `ratelimits` entry to Nitro's Wrangler config. Do not repeat those bindings in `nitro.cloudflare.wrangler`.

To use the Rate Limit integration directly, add the Nitro plugin with a Cloudflare preset and set the namespace yourself. The preset selects the Cloudflare provider, and Nitro writes the bindings to `wrangler.json`.

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

Cloudflare enforcement is best-effort, with 10-second or 60-second fixed windows. The build rejects `enforcement: 'strict'` and other periods rather than weaken a policy silently. Inspection reports per-location counters, unknown rejected-attempt behavior, and `availability: 'never'` for all quota metadata. The binding only allows or rejects.

The binding is request-scoped. If it is missing at runtime, the handle's `failure` policy decides whether to deny or allow the request. Rate Limiting bindings do not use Cloudflare KV and need no provisioning.

::warning
Give each Worker and environment its own namespace. Cloudflare shares counters across all Workers in an account that use the same namespace id.
::

Workspace adds an Artifacts binding when its Store selects Cloudflare Artifacts:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    workspace: {
      store: {
        provider: 'cloudflare-artifacts',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
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

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
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

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
        },
      },
    }),
  ],
})
```
:::
::

Check the `artifacts` entry in `wrangler.json` before you deploy. Workspace keeps your other Artifacts bindings. Cloudflare still defaults to the ephemeral `memory` Store, because Artifacts needs beta access.

### Browser Run bindings

Register the Browser integration when trusted server code needs Browser Run sessions.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    browser: true,
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
      host: 'cloudflare',
      browser: true,
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
      host: 'cloudflare',
      browser: true,
    }),
  ],
})
```
:::
::

ViteHub writes the `browser` binding, a compatible default `compatibility_date`, and the `nodejs_compat` flag. Browser Definitions import helpers from `vite-hub/browser`. Do not import provider modules or the generated `wrangler.json`.

`wrangler dev` can run Browser Run against a local browser. Set `browser: { remote: true }` to run Worker code locally with the Browser binding on Cloudflare, for example to test the hosted service.

## Read a binding

Use a ViteHub primitive when one covers the feature. For a Cloudflare feature that no primitive covers, such as a
Range request on an R2 bucket or a `send_email` binding, read the raw binding with `getHostBinding()` from
`vite-hub/runtime`. Declare the binding in the project `wrangler.json`, and run `wrangler types` so that the result
has the type of the binding.

This route uses the `VIDEOS` R2 binding and the generated `Cloudflare.Env` types.

```ts [server/routes/videos/[file].ts] fragment
import { defineEventHandler, getRouterParam } from "h3";
import { getHostBinding } from "vite-hub/runtime";

export default defineEventHandler(async (event) => {
  const [error, bucket] = getHostBinding("VIDEOS", event);
  if (error) return new Response(null, { status: 404 });
  const object = await bucket.get(`videos/${getRouterParam(event, "file")}`);
  return object ? new Response(object.body) : new Response(null, { status: 404 });
});
```

`getHostBinding()` also works in Schedules, Queues, and Workflows, which have no request event. Call it without
`event` there. It returns an error instead of throwing, so the same code can use another source in `vite dev` on Node.

### RUNTIME_HOST_BINDINGS_UNAVAILABLE

The code runs without host bindings, for example on Node, Vercel, or Netlify. Only Cloudflare Workers give bindings.
Build with the `cloudflare` preset, or handle the error.

### RUNTIME_HOST_BINDING_NOT_FOUND

The Worker has no binding with this name. Add it to the Wrangler config of the project, then run `wrangler types`.

## Production notes

Local development and deployed Workers do not always behave the same. Use Provider Output Contracts and Local Provider Runs for pull request checks, and keep Live Smoke tests on real deployments small.

::warning
The output can need real Worker bindings such as D1, R2, KV, Rate Limiting, Queues, Durable Objects, Cloudflare Artifacts, or Agent state. Check the bindings before you deploy, then smoke test the deployed Worker when they matter.
::

Agent Definitions run on Cloudflare through generated output when the Agent integration owns the route. Keep model keys, Durable Object state bindings, and other Runtime Env in Worker bindings.

### Console on Workers

Cloudflare can send two requests from one browser to different Workers. The [Console](/docs/development/console) sends each operation as one stateless `POST /_vitehub/rpc`, so it needs no session affinity or memory state. Agent runs started from the Console pass background work to the Worker's `waitUntil`. Configure a durable hosted run journal, as the [Console guide](/docs/development/console) describes.

To open the Worker in the Console, set `console: true`, link the Worker URL in the Console, and set the `VITEHUB_CONSOLE_KEY_<NAME>` line that it shows with `wrangler secret put`. See [Protect the Console route](/docs/development/console#protect-the-console-route).

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for exact package and proof coverage.
- Use [Provisioning](/docs/development/provisioning) for resource creation.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Verification](/docs/development/verification) for Cloudflare proof tiers.

## Related guides

For worked tasks, see [Deploy an Agent](/docs/guides/deploy-agent-cloudflare-vercel),
[D1 with Drizzle](/docs/guides/cloudflare-d1),
[R2 file storage](/docs/guides/cloudflare-r2), or
[Browser Run](/docs/guides/cloudflare-browser).
