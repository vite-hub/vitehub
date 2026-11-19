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
| Browser | Browser Run. It requires this host. |
| Email | Cloudflare Email for `email: true`. |
| Workers Logs | `observability: { enabled: true }` in `wrangler.json` |

The app name comes from `vitehub({ name })`, then `WRANGLER_CI_OVERRIDE_NAME`
in Workers Builds, then the `package.json` name. It is also the Worker name
unless `nitro.cloudflare.wrangler.name` is set.

## Workers Logs

Cloudflare keeps no Worker logs unless `wrangler.json` turns on
`observability`. ViteHub turns it on in the generated `wrangler.json`, so
`console.log` output and request logs show in the Cloudflare dashboard after
the first deploy.

To turn it off, or to set a sampling rate, put your own `observability` in
the project `wrangler.json`. ViteHub then leaves the key as you wrote it.

```json [wrangler.json]
{ "observability": { "enabled": false } }
```

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

Keep `host: 'cloudflare'` in development too. With the Vite configurations above, `vite dev` runs Nitro on Node by default. ViteHub supplies Node stubs for `cloudflare:workers` and `cloudflare:email`, as it does in `nuxt dev`. The `cloudflare:workers` stub reads request bindings and `process.env`.

In plain Vite, select the `miniflare` runner with `NITRO_DEV_RUNNER=miniflare` or `nitro.devServer.runner: 'miniflare'` to use the native modules in workerd. The `cloudflare-module` Nitro preset already selects Miniflare for `vite dev`. This runner selection does not remove the stubs in Nuxt.

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

The Nuxt-only `database.driver: 'cloudflare'` option sets up one host resource for Nuxt Content and Nitro. It is not a shortcut for a Vite Database Definition.

With the Console and Agents on, a Cloudflare build stores the Console run journal in this D1 binding. The journal creates its `vitehub_agent_invocations` table on first use. See [Cloudflare journal](/docs/console/agents#which-journal-the-console-reads).

## Provision boundary

Provision shows a dry-run plan before it applies changes. A successful apply writes non-secret ids to `.vitehub/provision.json`. Secrets stay in environment variables or provider env stores.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --host cloudflare --dry-run
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --host cloudflare
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

Some generated server files under `.vitehub/nitro/`, such as the Database middleware, import `cloudflare:workers`. In Nuxt, ViteHub adds the types of that module to the app's TypeScript config, so `nuxt typecheck` passes without `@cloudflare/workers-types`. When the app installs `@cloudflare/workers-types`, ViteHub adds its full types instead. You do not need a `declare module "cloudflare:workers"` file in the app.

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

A required secret Server Env declaration that reads exactly one variable name goes to `secrets.required` in the Wrangler config, and to each named Wrangler environment, since they do not inherit secrets. Wrangler reuses an existing Worker secret and stops the deploy when it is missing. ViteHub records only the name, never the value. Optional secrets, non-secret values, defaults, and fallback source lists stay runtime-only, because Wrangler's list cannot express fallbacks.

With the default `VITEHUB_` prefix, a declaration reads two names: `env({ secret: true, source: env.source('EXECUTOR_API_KEY') })` reads `VITEHUB_EXECUTOR_API_KEY`, then `EXECUTOR_API_KEY`. Either one works at runtime, so Wrangler cannot require one of them, and the build leaves it out. To get `secrets.required`, set `env: { prefix: false }`, or use a source equal to the canonical name. See [Variable names](/docs/env/configure#variable-names).

### Worker vars from Server Env

Set `cloudflare: { vars: true }` to write the non-secret Server Env values that are set when you build to `vars` in `.output/server/wrangler.json`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    cloudflare: { vars: true },
    env: {
      server: {
        executorUrl: env({ source: env.source('EXECUTOR_URL') }),
        executorApiKey: env({ secret: true, source: env.source('EXECUTOR_API_KEY') }),
        dryRun: env.boolean({ default: true, source: env.source('LABELLER_DRY_RUN') }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      cloudflare: { vars: true },
      env: {
        server: {
          executorUrl: env({ source: env.source('EXECUTOR_URL') }),
          executorApiKey: env({ secret: true, source: env.source('EXECUTOR_API_KEY') }),
          dryRun: env.boolean({ default: true, source: env.source('LABELLER_DRY_RUN') }),
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
      host: 'cloudflare',
      cloudflare: { vars: true },
      env: {
        server: {
          executorUrl: env({ source: env.source('EXECUTOR_URL') }),
          executorApiKey: env({ secret: true, source: env.source('EXECUTOR_API_KEY') }),
          dryRun: env.boolean({ default: true, source: env.source('LABELLER_DRY_RUN') }),
        },
      },
    }),
  ],
})
```
:::
::

With `EXECUTOR_URL=https://executor.example.com` and `LABELLER_DRY_RUN=false` in `.env`, the build writes `"vars": { "EXECUTOR_URL": "https://executor.example.com", "LABELLER_DRY_RUN": "false" }`. `EXECUTOR_API_KEY` stays out.

- ViteHub reads the process environment and the `.env` files that Vite loads for the build mode. `.env.development` never applies to `vite build`.
- Each value keeps the name that holds it, in the order Server Env reads names at runtime. `VITEHUB_EXECUTOR_URL` wins over `EXECUTOR_URL`.
- A name read by a secret declaration is not copied to `vars`, even if another declaration also reads it. Set secrets with `wrangler secret put` or [upload them with the version](#upload-secrets-with-the-version).
- A missing or empty value, a default, a literal, and a provider source stay out. The default applies at runtime.
- A var that your Wrangler config already sets keeps its value. Named Wrangler environments get the same vars, since they do not inherit them.

::warning
Build where the deployment values are set, such as Workers Builds. A build that reads a `.env` made for local testing sends those values to the Worker.
::

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

### Upload secrets with the version

`vitehub deploy` uploads the Worker secrets that the app reads with the new version. It writes the values to a temporary JSON file and passes it to `wrangler deploy --secrets-file`, or to `wrangler versions upload` for `--preview`. The file has mode 600 and is deleted after the deploy.

- A secret set before the deploy would roll the old code out with the new value. With the version, the old code keeps its values.
- A preview version gets the values of `.env.preview`, and production keeps its own.
- The file is JSON, because Wrangler's dotenv mode expands `$VAR` and lets the shell override file values.
- Wrangler keeps the secrets that the file does not name.

See [Deploy from your machine](/docs/cli/project#deploy-from-your-machine) for the names that deploy checks and the values that it sets.

### Rate Limiting bindings

With `vitehub({ host: 'cloudflare', rateLimit: true })`, ViteHub selects the Cloudflare driver and uses the app name as the namespace. Each `requireRateLimit()` policy in a handler adds one `ratelimits` entry to Nitro's Wrangler config. Do not repeat those bindings in `nitro.cloudflare.wrangler`.

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

Cloudflare enforcement is best-effort, with 10-second or 60-second fixed windows. The build rejects `enforcement: 'strict'` on these windows rather than weaken a policy silently. A Rate Limit with another window counts in the default KV store, which needs a shared atomic `increment`, such as Upstash. See [Windows longer than one minute](/docs/rate-limit/hosts#windows-longer-than-one-minute). Inspection reports per-location counters, unknown rejected-attempt behavior, and `availability: 'never'` for all quota metadata. The binding only allows or rejects.

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
        driver: 'cloudflare',
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
          driver: 'cloudflare',
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
          driver: 'cloudflare',
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

Cloudflare can send two requests from one browser to different Workers. The [Console](/docs/console) sends each operation as one stateless `POST /_vitehub/rpc`, so it needs no session affinity or memory state. Agent runs started from the Console pass background work to the Worker's `waitUntil`. Configure a durable hosted run journal, as the [Console guide](/docs/console) describes.

To open the Worker in the Console, set `console: true`, link the Worker URL in the Console, and set the `VITEHUB_CONSOLE_KEY_<NAME>` line that it shows with `wrangler secret put`. See [Protect the Console route](/docs/console/access#who-can-call-the-endpoint).

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
