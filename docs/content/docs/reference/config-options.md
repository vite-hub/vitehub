---
title: Config options
description: The main ViteHub config options, their defaults, and where provider choices go.
navigation.order: 55
navigation.group: Setup
icon: i-lucide-sliders-horizontal
---

Integration Options are the options you pass to `vitehub()` or a package's Vite plugin. Pick the provider here when the choice changes generated output, bindings, imports, or deployment.

## Built-in deployment preset

`vitehub()` requires exactly one built-in `preset`: `cloudflare`, `netlify`, `vercel`, `deno`, or `node`. The preset alone sets the host, runtime, Nitro output, packaging, and built-in Blob, Queue, Rate Limit, and Sandbox adapters. A Nitro or hosting environment setting that conflicts with it fails the config.

`name` is the deployment name. On Cloudflare it resolves in this order:

1. An explicit `name`.
2. `WRANGLER_CI_OVERRIDE_NAME`, which Cloudflare Workers Builds sets to the connected Worker. An explicit `name` that differs from it fails, because the connected Worker is still the deploy target.
3. The nearest `package.json` name.
4. The Vite root folder name.

Cloudflare uses this name for the default Worker, Blob bucket, Queue prefix, Rate Limit namespace, Sandbox, and Container names. Outside Workers Builds, an explicit Wrangler Worker name wins. Explicit Blob bucket, driver, or store options also win. These names are stable, but ViteHub does not create the R2 bucket or Queue for them. The generated deployment manifest records the name and where it came from.

| Import | Public type | Placement | Defaults |
| --- | --- | --- | --- |
| `vite-hub` | `ViteHubOptions` | `vitehub({ preset })` in Vite `plugins` | Includes Env. Turn on other features with `true` or an options object. |

- If the preset cannot support a feature you ask for, the build fails. It never picks a weaker provider in silence.
- The `node` preset keeps its filesystem Blob store on one host and its memory Rate Limiter in one process, on purpose.
- The `deno` preset rejects Schedule and `agent.runtime: "deno"`, because its deployed Nitro entrypoint does not include those generated servers. Deno output stages runtime packages, validates a deployment manifest, and adds a non-interactive create-or-update runner.
- Each `hubX()` plugin is still available from its `@vite-hub/*/vite` package path, with its full option types.

`vitehub()` turns on Agent, Blob, Browser, Channels, Connections, Database, KV, Queue, Rate Limit, Sandbox Task, Schedule, Workflow, and Workspace with `true`. Email accepts `true` with the Cloudflare preset, where it selects the Cloudflare Email driver; other presets reject that boolean default and require explicit provider options. Auth works the same way but has no plugin options yet.

## Vite Integration options

In `vitehub()`, omit a key or set it to `false` to turn the feature off. Set `true` for the defaults, or an object to set options.

| Package | Public type | Placement | Confirmed options and defaults |
| --- | --- | --- | --- |
| Agent | `AgentModuleOptions` | `agent` config key or `hubAgent(options)` | `runtime`: `auto`, `cloudflare-agents`, `deno`, `unknown`, `vercel`, `vite`; default `auto`. `execution`: `inline`, `sandbox`, `workflow`; default `inline`. `imports` defaults to `true`. `invocations` (`vitehub()` only) sets the app-wide [Invocation journal](/docs/agents/invocation-storage#use-one-journal-for-every-agent): `"database"`, `"memory"`, `false`, or `{ store, ...options }`. If omitted, nothing is recorded outside the Console. `integrations.sandbox` and `integrations.workflow` default to `auto`. Provider groups `sandbox`, `scheduler`, and `state` default to provider `auto`. `auto` state is Cloudflare state on Cloudflare and local SQLite at `file:.vitehub/data/agent-state.sqlite` in Vite dev. Production needs a durable `VITEHUB_AGENT_STATE_URL` or explicit provider options. Hosted Agents mount `/api/_vitehub/agents/[agent]/chat`. Each Agent's route-enabled Channel decides if it answers. Webhook routes belong to Channels and stay available for adapter delivery. `routes.discordGateway` generates the Discord Gateway listener route; `true` uses the default route. `routes.inspection` is off by default. `true` mounts `/api/_vitehub/agents/[agent]/inspection`, and a string sets a custom route. Inspection shows operational metadata and adds no authorization: the host must authorize the route before ViteHub resolves the Agent. `shutdown.drainMs` sets the default for `VITEHUB_SHUTDOWN_DRAIN_MS`, the shared time budget of every [stop signal drain](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) on a persistent server. `shutdown: false` removes the inline Chat drain. |
| Auth | `AuthModuleOptions` | `auth` config key or `hubAuth(options)` | `false` turns it off. No plugin options yet. `defineAuth()` owns `basePath` default `/api/auth`, `route: false`, `access`, `database`, `secondaryStorage`, and `runtime`. |
| Blob | `BlobModuleOptions` | `blob` config key or `hubBlob(options)` | `true` uses the preset's store. Drivers include `fs`, `cloudflare-r2`, `netlify-blobs`, `vercel-blob`, `minio`, `s3`, `gcs`, `azure`, and other exported Blob drivers. Defaults: Cloudflare uses `cloudflare-r2` binding `BLOB`. Netlify uses `netlify-blobs`. `BLOB_READ_WRITE_TOKEN` or Vercel uses `vercel-blob` with `access: "public"`. Otherwise `fs` at `.vitehub/data/blob`. MinIO defaults to bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true`. `images` sets image variants: `transformer` is `auto` (default), `sharp`, `cloudflare-images`, or `passthrough`. `sizes`, `quality`, and `binding` (default `IMAGES`) tune it. `false` serves originals. |
| Browser | `BrowserModuleOptions` | `browser` config key or `hubBrowser(options)` | `true` turns on Cloudflare Browser Run with binding `BROWSER`. `{ binding }` renames the binding. `remote: true` connects local Wrangler dev to the hosted service. Browser Definitions need the Cloudflare preset. `vitehub()` and `hubBrowser()` generate the binding and needed compatibility fields, and keep other Wrangler fields. |
| Cache | `CacheOptions` | `cache` config key in `vitehub()` | Off by default: Nitro's `cache` mount does not change. `true` mounts the preset's store: Cloudflare `cloudflare-kv-binding` binding `CACHE` (with `namespaceId`, or an existing `CACHE` namespace ID), Vercel `vercel-runtime-cache`, Deno `deno-kv` with base `cache`, Node `fs-lite` at `.vitehub/data/cache` (or `<dataDir>/cache`). Netlify has no default and fails the build. An object picks one of these drivers, and each needs its preset. Cloudflare accepts `binding` and `namespaceId`. `fs-lite` and `deno-kv` accept `base`. Dev uses `fs-lite` in the local cache folder. `{ driver: "kv" }` works on every preset, in dev too, and needs `kv`: it stores the cache in the default KV Store under the `nitro-cache:` prefix (`base` changes it). A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) wins. |
| Channels | `ChannelsVitePluginOptions` | `channels` config key or `hubChannels(options)` | `true` discovers `server/channels/<path>.ts` and `<path>.channel.ts`. `projectRoot` changes where ViteHub looks. Connectors and provider credentials go in the Channel Definition. |
| Connections | `ConnectionsVitePluginOptions` | `connections` config key or `hubConnections(options)` | `true` discovers `server/connections/<path>.ts`. Needs `database`, which defaults to `default`. `encryptionKey` defaults to the optional secret `VITEHUB_CONNECTIONS_KEY`. It cannot use `env.provider()` or a default. |
| Console | `boolean \| ConsoleOptions` | `console` config key in `vitehub()` | When off, ViteHub adds no [Console](/docs/development/console) page, RPC endpoint, plugin, or assets. `true` reuses app Auth and its server access policy, with built-in social sign-in. An object needs `auth`: `false` for no sign-in, `'app'` for the app Auth Session, or a Console Auth config such as `{ provider: 'cloudflare-access' }`. `authorize` is a server file that every Console data route calls. It can return `{ sections }` to allow only some sections. `invoke` defaults to `true` in dev and `false` in production builds. The Agent Console uses the shared invocation journal of the Agent Definitions. Without one, it uses local SQLite at `.vitehub/data/console.sqlite`. |
| Database | `DBModulePublicOptions` | `database` config key or `hubDb(options)` | `projectRoot` sets the root for discovery, generated files, and provisioning. Relative paths resolve from the Vite root, or the Nuxt `rootDir` in Nuxt. `cli.generate` and `cli.migrate` each turn off with `false`. `connection` sets a hosted libSQL default for Vercel and other hosted output. Cloudflare D1 runtime fields are `driver: "d1"`, `binding`, `databaseId`, `previewDatabaseId`, `databaseName`, `migrationsTable`, and `local.filename`. Database Definitions own tables and can override the connection values. |
| Email | `EmailVitePluginOptions` | `email` config key or `hubEmail(options)` | `driver` is `resend` or `cloudflare-email`; `options` accepts serializable literals and runtime Env declarations. `email: true` works only on Cloudflare. Each Markdown file under `server/emails/**/*.md` becomes a typed `#vitehub/emails/<name>` renderer import. |
| Env | `EnvIntegrationOptions` and `EnvViteConfigOptions` | `env` config key, `hubEnv(options)`, plus Vite `env` config | `diagnostics`: `off`, `summary`, `trace`; default `summary`. `prefix` changes inferred variable names. `projectRoot` changes where generated files go. `providers` maps read-only runtime provider names to app modules. Vite `env.public`, `env.define`, and `env.server` hold Public Env, build define values, and Server Env. |
| KV | `KVModuleOptions` | `kv` config key or `hubKv(options)` | Accepts `false`, one store config, or `{ stores }` with `stores.default`. Driver literals are `fs-lite`, `cloudflare-kv-binding`, `deno-kv`, and `upstash`. Defaults: Deno uses `deno-kv`. Upstash env or Vercel uses `upstash`. Cloudflare uses `cloudflare-kv-binding` binding `KV`. Otherwise `fs-lite` at `.vitehub/data/kv`. |
| Queue | `boolean` in `vitehub()`; `QueueModuleOptions` in `hubQueue()` | `queue: true` in `vitehub()`, or `hubQueue(options)` from `@vite-hub/queue/vite` | `vitehub()` accepts only `true` or `false`. The preset picks the provider: `cloudflare` (queue names get the deployment name as prefix) or `vercel`. `netlify`, `node`, and `deno` have no Queue provider, so `queue: true` fails. Provider options such as Cloudflare `binding`, Vercel `region`, and shared `cache` go in the Vite config `queue` key or `hubQueue(options)`. With `vitehub()`, the preset still sets `provider`. Concurrency and retries go in the Queue Definition or enqueue options. |
| Rate Limit | `RateLimitVitePluginOptions` | `rateLimit` config key or `hubRateLimit(options)` | `provider`: `auto`, `cloudflare`, or `memory`; default `auto`. `auto` uses memory in Vite serve and Cloudflare on a known Cloudflare production host. Cloudflare needs a `namespace` unique to the deployment. `projectRoot` and `scanDirs` override where sources are collected. Each `requireRateLimit()` call in a handler sets its static limits, windows, guarantees, and failure behavior. |
| Realtime | `RealtimeModuleOptions` | `realtime` config key or `hubRealtime(options)` | `authority`: `auto`, `cloudflare`, or `memory`; default `auto`. `auto` uses a Durable Object when Realtime finds a Cloudflare Nitro preset or hosting environment. With only `vitehub({ preset: 'cloudflare' })` in Vite dev, set `authority: 'cloudflare'` yourself. Other presets use process memory in dev. Other production builds need an explicit authority, and `memory` is accepted only for a single-process server. Realtime Definitions keep the engine and document format apart from this choice. |
| Sandbox Task | `boolean` in `vitehub()`; `SandboxTaskPublicOptions` in `hubSandboxTask()` | `sandboxTask: true` in `vitehub()`, or `hubSandboxTask(options)` from `@vite-hub/sandbox/task/vite` | `vitehub()` accepts only `true` or `false`. The preset picks the provider: `cloudflare` or `vercel`. `netlify`, `node`, and `deno` have no Sandbox provider, so `sandboxTask: true` fails. Other provider options go in the Vite config `sandboxTask` key or `hubSandboxTask(options)`. With `vitehub()`, the preset still sets `provider`. Cloudflare defaults: binding `SANDBOX`, class `Sandbox`, migration tag `v1`. Per-run sandbox identity goes in Sandbox Run options. |
| Schedule | `ScheduleVitePluginOptions` | `hubSchedule(options)` | `providerOutput`: `auto`, `standalone`, `nitro`, or `false`; default `auto`. Output targets only the build's host. `projectRoot` changes where it is written. There is no public `schedule.provider` option. |
| Workflow | `WorkflowModuleOptions` | `workflow` config key or `hubWorkflow(options)` | `provider`: `cloudflare`, `openworkflow`, or `vercel`. Cloudflare uses `cloudflare`. Node or Docker with OpenWorkflow storage config uses `openworkflow`. Other supported hosts use `vercel`. Netlify does not infer a provider. Shared fields are `binding` and `name`. OpenWorkflow fields are `postgres`, `sqlite`, and `worker.concurrency`. Set storage with `postgres.url` or `sqlite.path`. `workflow.database` is not supported. |
| Workspace | `WorkspaceModuleOptions` | `workspace` config key or `hubWorkspace(options)` | `root` defaults to `.vitehub/workspaces`. `projectRoot` changes how the source root resolves. `assets` controls build-time assets. `store` providers: `local`, `memory`, `cloudflare-artifacts`, `vercel-blob`, `github`. Choosing `cloudflare-artifacts` generates its Cloudflare binding. Defaults: local dev uses `local`. Cloudflare uses `memory`. `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` uses `vercel-blob`. Vercel without Blob env uses `memory`. Otherwise `local`. |

::agent-only{skill="cache" title="Cache"}
Use the ViteHub `cache` integration when Nitro cache storage should use a host-appropriate driver. Cache is for replaceable values. It is not the source of truth for durable application data.

Read the [configuration reference](/docs/reference/config-options#vite-integration-options) and the [host guide](/docs/frameworks-hosts). The integration selects Cloudflare KV, Vercel runtime cache, Deno KV, or local filesystem storage from the preset and options.

Keep cache keys, expiry, and invalidation in application code. A `nitro.kv` (`nitro.storage` in Nuxt) cache mount takes precedence over the ViteHub cache option. Netlify requires an explicit supported arrangement.

Prove a miss, a hit, expiry or invalidation, and the selected host output. Never use cache as the only copy of data that must survive eviction.
::

## Option placement

| Option kind | Belongs in | Example |
| --- | --- | --- |
| Integration Options | Vite config or package integration call | Provider choice, generated output mode, project root. |
| Definition Options | The Definition file (`define*()`) | Queue concurrency, Database tables, Workspace Sources and rules. |
| Invocation Options | Runtime Helper call | Sandbox Identity, Agent input options, schedule creation input. |
| Runtime Env | Server Env | Provider tokens, app secrets, request-time runtime values. |

This page only summarizes provider driver fields. For deep provider setup, read the exported package types. Keep provider choices in Integration Options, unless the package documents an invocation-time option.

## Agent eval options

Set Agent Eval Runner defaults in the Agent options.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: "node",
    agent: {
      eval: {
        cache: true,
        maxConcurrency: 2,
        scoreThreshold: 85,
        testTimeout: 60_000,
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
      preset: "node",
      agent: {
        eval: {
          cache: true,
          maxConcurrency: 2,
          scoreThreshold: 85,
          testTimeout: 60_000,
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
      preset: "node",
      agent: {
        eval: {
          cache: true,
          maxConcurrency: 2,
          scoreThreshold: 85,
          testTimeout: 60_000,
        },
      },
    }),
  ],
})
```
:::
::

## Env options

Env keeps Public Env, compile-time define values, and Server Env apart. Put secrets in `env.server`, never in `env.public` or `env.define`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: "node",
    env: {
      diagnostics: 'summary',
      providers: { credentials: './server/env/credentials.ts' },
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
      server: {
        apiToken: env({ secret: true, source: env.source('API_TOKEN') }),
        githubToken: env({ secret: true, source: env.provider('credentials', 'github/token') }),
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
  plugins: [vitehub({
    preset: "node",
    env: {
      diagnostics: 'summary',
      providers: { credentials: './server/env/credentials.ts' },
    },
  }), nitro()],
  env: {
    public: {
      appName: env({ default: 'Acme', mode: 'build' }),
    },
    server: {
      apiToken: env({ secret: true, source: env.source('API_TOKEN') }),
      githubToken: env({ secret: true, source: env.provider('credentials', 'github/token') }),
    },
  },
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    preset: "node",
    env: {
      diagnostics: 'summary',
      providers: { credentials: './server/env/credentials.ts' },
    },
  })],
  env: {
    public: {
      appName: env({ default: 'Acme', mode: 'build' }),
    },
    server: {
      apiToken: env({ secret: true, source: env.source('API_TOKEN') }),
      githubToken: env({ secret: true, source: env.provider('credentials', 'github/token') }),
    },
  },
})
```
:::
::

## Related

- [Vite](/docs/frameworks-hosts)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provisioning](/docs/development/provisioning)
- [Provider output](/docs/reference/provider-output)
