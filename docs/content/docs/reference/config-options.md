---
title: Config options
description: The main ViteHub config options, their defaults, and where provider choices go.
navigation.order: 55
navigation.group: Setup
icon: i-lucide-sliders-horizontal
---

Integration Options are the options you pass to `vitehub()` or a package's Vite plugin. Pick the provider here when the choice changes generated output, bindings, imports, or deployment.

## Built-in host

`vitehub()` builds for exactly one built-in `host`: `cloudflare`, `netlify`, `vercel`, `deno`, or `node`. Set `host` to select it explicitly, or omit it to detect the host from the environment and fall back to `node`. The host sets the runtime, Nitro output, packaging, and built-in Blob, Queue, Rate Limit, and Sandbox adapters. A Nitro or hosting environment setting that conflicts with it fails the config.

`name` is the deployment name. On Cloudflare it resolves in this order:

1. An explicit `name`.
2. `WRANGLER_CI_OVERRIDE_NAME`, which Cloudflare Workers Builds sets to the connected Worker. An explicit `name` that differs from it fails, because the connected Worker is still the deploy target.
3. The nearest `package.json` name.
4. The Vite root folder name.

Cloudflare uses this name for the default Worker, Blob bucket, Queue prefix, Rate Limit namespace, Sandbox, and Container names. Outside Workers Builds, an explicit Wrangler Worker name wins. Explicit Blob bucket, driver, or store options also win. These names are stable, but ViteHub does not create the R2 bucket or Queue for them. The generated deployment manifest records the name and where it came from.

| Import | Public type | Placement | Defaults |
| --- | --- | --- | --- |
| `vite-hub` | `ViteHubOptions` | `vitehub({ host })` in Vite `plugins` | Includes Env. Turn on other features with `true` or an options object. |

- If the host cannot support a feature you ask for, the build fails. It never picks a weaker provider in silence.
- The `node` host keeps its filesystem Blob store on one host and its memory Rate Limiter in one process, on purpose.
- The `deno` host rejects Schedule and `agent.runtime: "deno"`, because its deployed Nitro entrypoint does not include those generated servers. Deno output stages runtime packages, validates a deployment manifest, and adds a non-interactive create-or-update runner.
- Each `hubX()` plugin is still available from its `@vite-hub/*/vite` package path, with its full option types.

`vitehub()` turns on Agent, Auth, Blob, Browser, Channels, Connections, Database, KV, Observability, Queue, Rate Limit, Sandbox Task, Schedule, Workflow, and Workspace with `true`. Email accepts `true` with the Cloudflare host, where it selects the Cloudflare Email driver; other hosts reject that boolean default and require explicit provider options.

`vitehub()` is the only config place. Call it with no argument for the defaults. Each feature has one key, `<feature>?: boolean | <Feature>Options`, and `vite-hub` exports each option type with that name, such as `KVOptions` and `ObservabilityOptions`. Vite does not read top-level feature keys such as `kv` or `env`. A direct owner plugin takes the same options as its argument, such as `hubKV(options)`.

## Vite Integration options

In `vitehub()`, omit a key or set it to `false` to turn the feature off. Set `true` for the defaults, or an object to set options.

| Package | Public type | Placement | Confirmed options and defaults |
| --- | --- | --- | --- |
| Agent | `AgentOptions` | `agent` config key or `hubAgent(options)` | Omission or `false` disables Agent in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `runtime`: `auto`, `cloudflare-agents`, `deno`, `unknown`, `vercel`, `vite`; default `auto`. `execution`: `inline`, `sandbox`, `workflow`; default `inline`. `imports` defaults to `true`. `invocations` (`vitehub()` only) sets the app-wide [Invocation journal](/docs/agents/invocation-storage#use-one-journal-for-every-agent): `"database"`, `"memory"`, `false`, `{ store, ...options }`, or the [default journal](/docs/agents/invocation-storage#use-the-default-journal) options `{ databaseUrl, observations, retention }`; omission installs the default journal, with the Console on or off. `providers.state.provider` defaults to `auto`. Automatic state uses Cloudflare state on Cloudflare and local SQLite at `file:.vitehub/data/agent-state.sqlite` during Vite development; production output requires a durable `VITEHUB_AGENT_STATE_URL` or explicit provider options. Hosted Agent Definitions mount `/api/_vitehub/agents/[agent]/chat`; each Agent's route-enabled Channel controls whether it answers. Webhook routes remain Channel-owned and available for adapter delivery. Set `routes.discordGateway` to generate the Discord Gateway listener route; `true` selects the package default route. `routes.inspection` is disabled by default; `true` mounts `/api/_vitehub/agents/[agent]/inspection`, while a string selects a custom route. Inspection includes operational metadata and does not add authorization. The host must authorize the route before ViteHub resolves the Agent. `shutdown.drainMs` sets the default for `VITEHUB_SHUTDOWN_DRAIN_MS`, the shared budget of every [stop signal drain](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) on a persistent server; `shutdown: false` removes the inline Chat drain. |
| Auth | `boolean \| AuthOptions` | `auth` config key or `hubAuth(options)` | `false` disables the integration. The enabled integration has no plugin option bag yet. `defineAuth()` owns `basePath` default `/api/auth`, `route: false`, `access`, `database`, `secondaryStorage`, and `runtime`. |
| Blob | `BlobOptions` | `blob` config key or `hubBlob(options)` | Omission or `false` disables Blob in `vitehub()`; `true` enables the selected host's store, and an options object enables and configures it. Driver literals include `fs`, `cloudflare-r2`, `netlify-blobs`, `vercel-blob`, `minio`, `s3`, `gcs`, `azure`, and other exported Blob drivers. Defaults: Cloudflare hosting selects `cloudflare-r2` binding `BLOB`; Netlify hosting selects `netlify-blobs`; `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN`, or Vercel hosting selects `vercel-blob` with `access: "public"`; otherwise the integration selects `fs` at `.vitehub/data/blob`. In `vite dev`, an inferred Vercel Blob store uses `fs`, and an inferred R2 store uses `fs` when the dev runner has no R2 binding, unless the store sets `remote: true`. Builds ignore `remote`. MinIO defaults to bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true`. `images` sets image variants: `transformer` is `auto` (default), `sharp`, `cloudflare-images`, or `passthrough`; `sizes`, `quality`, and `binding` (default `IMAGES`) tune it; `false` serves originals. |
| Browser | `BrowserOptions` | `browser` config key or `hubBrowser(options)` | Omission or `false` disables Browser in `vitehub()`; `true` enables Cloudflare Browser Run actions with binding `BROWSER`, `{ binding }` changes the binding name, and `remote: true` connects local Wrangler development to the hosted service. Browser Definitions currently require the Cloudflare host. The root integration and direct standalone `hubBrowser()` output generate the binding and required compatibility fields while preserving unrelated Wrangler fields. |
| Bundle | `boolean` | `bundle` config key in `vitehub()` | Omission or `false` writes nothing. `true` writes a report of each production build to `.vitehub/bundle/`: client and server size, the code that loads at startup, and the package or folder of each module. Read it with `vitehub bundle` and `vitehub bundle why <package or file>`. Development is not measured. See [Bundle reports](/docs/bundle). |
| Cache | `CacheOptions` | `cache` config key in `vitehub()` | Omission or `false` leaves Nitro's `cache` mount unchanged. `true` mounts the host's store: Cloudflare `cloudflare-kv-binding` binding `CACHE` (with `namespaceId`, or an existing `CACHE` namespace ID), Vercel `vercel-runtime-cache`, Deno `deno-kv` with base `cache`, Node `fs-lite` at `.vitehub/data/cache` (or `<dataDir>/cache`). Netlify has no default and fails the build. An options object selects one of these drivers; each driver requires its host. Cloudflare accepts `binding` and `namespaceId`, `fs-lite` and `deno-kv` accept `base`. Development uses `fs-lite` at the local cache directory. `{ driver: "kv" }` works on every host: it stores the cache in the default KV Store under the `nitro-cache:` prefix (`base` changes it), in development too, and requires `kv`. A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) takes precedence. |
| Channels | `ChannelsOptions` | `channels` config key or `hubChannels(options)` | Omission or `false` disables Channel discovery in `vitehub()`; `true` discovers `server/channels/<path>.ts` and `<path>.channel.ts`. `projectRoot` changes where ViteHub looks for those files. Connectors and provider credentials belong in the Channel Definition. |
| Connections | `ConnectionsOptions` | `connections` config key or `hubConnections(options)` | Omission or `false` disables Connections in `vitehub()`; `true` discovers `server/connections/<path>.ts`. Requires `database`. `database` defaults to `default`. `encryptionKey` defaults to the optional secret `VITEHUB_CONNECTIONS_KEY` and cannot use `env.provider()` or a default. |
| Console | `boolean \| ConsoleOptions` | `console` config key in `vitehub()` | Omission or `false` registers no [Console](/docs/development/console) endpoint or plugin in a production build. `vite dev` without the option serves only the Operations endpoint. `true` serves `POST /_vitehub/rpc`, which takes only requests that the ViteHub Console or the CLI [signed](/docs/development/console#sign-console-requests) with a key in a `VITEHUB_CONSOLE_KEY_<NAME>` variable. An options object does the same. `auth: false` takes calls without a signature, for development only (a production build fails). `authorize` is a server file that every Console call runs. It can return `{ sections }` to allow only some sections. `invoke` defaults to `true` in development and `false` in production builds. The Agent Console reads the shared invocation journal of discovered Agent Definitions. Without one, it reads the [default Agent journal](/docs/agents/invocation-storage#use-the-default-journal), which ViteHub installs with the Console on or off. |
| Database | `DatabaseOptions` | `database` config key or `hubDatabase(options)` | Omission or `false` disables Database in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `projectRoot` sets the Database discovery, generated-artifact, and provisioning root; relative paths resolve from the Vite root in Vite and the Nuxt `rootDir` in Nuxt. Integration options are `cli.generate` and `cli.migrate`, each disableable with `false`. `connection` supplies a hosted libSQL default for Vercel and other hosted output. Cloudflare D1 runtime fields are `driver: "d1"`, `binding`, `databaseId`, `previewDatabaseId`, `databaseName`, `migrationsTable`, and `local.filename`. Database Definitions own tables and may override integration connection values. |
| Email | `EmailOptions` | `email` config key or `hubEmail(options)` | `driver` is `resend` or `cloudflare-email`; `options` accepts serializable literals and runtime Env declarations. Omission or `false` disables Email in `vitehub()`. The root package also accepts `email: true` on Cloudflare and rejects it on other hosts. Markdown under `server/emails/**/*.md` is discovered recursively and exposed through typed `#vitehub/emails/<name>` renderer imports. |
| Env | `EnvOptions` | `env` config key in `vitehub()`, or `hubEnv(options)` | On by default in `vitehub()`; `false` turns it off. `public`, `define`, and `server` declare Public Env, build define values, and Server Env. `diagnostics`: `off`, `summary`, `trace`; default `summary`. `prefix` changes inferred environment variable names. `projectRoot` changes generated file placement. `providers` maps read-only runtime provider names to application modules. |
| KV | `KVOptions` | `kv` config key or `hubKV(options)` | Accepts `false`, one store config, or `{ stores }` with `stores.default`. Driver literals are `fs-lite`, `cloudflare-kv-binding`, `deno-kv`, and `upstash`. Defaults: Deno hosting selects `deno-kv`; Upstash env selects `upstash`; Vercel hosting selects `upstash`; Cloudflare hosting selects `cloudflare-kv-binding` binding `KV`; otherwise `fs-lite` at `.vitehub/data/kv`. |
| Observability | `boolean \| ObservabilityOptions` | `observability` config key in `vitehub()` | Omission or `false` registers nothing. `true` registers the Evlog Nitro module for request logs. `evlog` passes Evlog options, such as `sampling` and `redact`. `logs: true` keeps a bounded Evlog buffer in `vite dev` that the Console and `vitehub logs` read; `logs: { source }` reads an existing backend through a `LogSource` module, in development and production, and starts no logger without `service`. `service` installs `useObservability()` for Agent telemetry, and enables `posthog` export and `papercuts`. See [Observability](/docs/agents/observability) and [Logs](/docs/logs). |
| Queue | `boolean \| QueueOptions` | `queue` config key in `vitehub()`, or `hubQueue(options)` from `@vite-hub/queue/vite` | Omission or `false` disables Queue. `true` uses the host's provider: `cloudflare` selects `cloudflare` and prefixes queue names with the deployment name, `vercel` selects `vercel`, and `node` selects the `local` provider, which runs jobs in the server process and works on one instance only. The `netlify` and `deno` hosts have no Queue provider, so `queue` fails configuration there. An options object sets provider options such as Cloudflare `binding`, Vercel `region`, local `base`, and shared `cache`; `provider` replaces the host's provider. Queue concurrency and retry behaviour belong to Queue Definition or enqueue options. |
| Rate Limit | `RateLimitOptions` | `rateLimit` config key or `hubRateLimit(options)` | `provider`: `auto`, `cloudflare`, or `memory`; default `auto`. Auto selects memory for Vite serve and Cloudflare for a known Cloudflare production host. Cloudflare requires a deployment-unique `namespace`. `projectRoot` and `scanDirs` are source-collection escape hatches. Handler-local `requireRateLimit()` calls own static limits, windows, enforcement guarantees, and failure behavior. |
| Realtime | `RealtimeOptions` | `realtime` config key or `hubRealtime(options)` | `authority`: `auto`, `cloudflare`, or `memory`; default `auto`. Auto uses a Durable Object when Realtime can resolve a Cloudflare Nitro preset or hosting environment. With only `vitehub({ host: 'cloudflare' })` during Vite development, set `authority: 'cloudflare'` explicitly. Other development hosts fall back to process memory. Other production builds require an explicit authority; `memory` is accepted only for a single-process server. Realtime Definitions keep the engine and document format separate from this deployment choice. |
| Sandbox Task | `boolean` in `vitehub()`; `SandboxTaskOptions` in `hubSandboxTask()` | `sandboxTask: true` in `vitehub()`, or `hubSandboxTask(options)` from `@vite-hub/sandbox/task/vite` | `vitehub()` accepts only `true` or `false`. The host selects the provider: `cloudflare` or `vercel`. The `netlify`, `node`, and `deno` hosts have no Sandbox provider, so `sandboxTask: true` fails configuration. Other provider options go in direct `hubSandboxTask(options)`. Cloudflare defaults are binding `SANDBOX`, class name `Sandbox`, and migration tag `v1`. Per-run sandbox identity belongs to Sandbox Run invocation options. |
| Schedule | `ScheduleOptions` | `hubSchedule(options)` | `providerOutput`: `auto`, `standalone`, `nitro`, or `false`; default `auto`. Generated output targets only the build's host. `projectRoot` changes where generated schedule output is written. There is no public `schedule.provider` option. |
| systemd | `boolean \| SystemdOptions` | `systemd` config key in `vitehub()` | On by default for the `node` host; other hosts ignore it. A production build writes `.output/<name>.service`. `name` defaults to the deployment name. `workingDirectory` defaults to the project root of the build. `environmentFile` defaults to `.env` in that directory, read only when it exists; `false` reads no file. `user`, `group`, and `environment` add `User=`, `Group=`, and `Environment=`. `TimeoutStopSec` is the `agent.shutdown.drainMs` budget, or `environment.VITEHUB_SHUTDOWN_DRAIN_MS`, plus 30 seconds. `false` writes no unit. See [Run the server with systemd](/docs/frameworks-hosts/node-self-hosted#run-the-server-with-systemd). |
| Workflow | `WorkflowOptions` | `workflow` config key or `hubWorkflow(options)` | Omission or `false` disables Workflow in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `provider`: `cloudflare`, `openworkflow`, or `vercel`. Cloudflare hosting selects `cloudflare`; Node or Docker hosting, also `vite dev` with the `node` host, selects `openworkflow`; other supported hosts select `vercel`. Netlify does not infer a provider. Shared fields are `binding` and `name`. OpenWorkflow fields are `postgres`, `sqlite`, and `worker`. Each Nitro server starts the OpenWorkflow worker; `worker: false` turns it off, and `worker.concurrency` sets how many runs it executes at the same time. Without `postgres.url` or `sqlite.path`, OpenWorkflow uses `OPENWORKFLOW_POSTGRES_URL`, then the app's Postgres Default Database, else a SQLite file. `vite dev` uses the SQLite file unless `remote: true`. Only discovered Workflow files run on OpenWorkflow; other Workflows run inline. Select storage with `postgres.url` or `sqlite.path`; `workflow.database` is unsupported. |
| Workspace | `WorkspaceOptions` | `workspace` config key or `hubWorkspace(options)` | Omission or `false` disables Workspace in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `root` defaults to `.vitehub/workspaces`. `projectRoot` changes source root resolution. `assets` controls build-time asset generation. `store` provider literals are `local`, `memory`, `cloudflare-artifacts`, `vercel-blob`, and `github`. Explicit `cloudflare-artifacts` selection generates its Cloudflare binding. Defaults: local development uses `local`; Cloudflare hosting uses `memory`; `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` selects `vercel-blob`; Vercel hosting without Blob env uses `memory`; otherwise `local`. |

::agent-only{skill="cache" title="Cache"}
Use the ViteHub `cache` integration when Nitro cache storage should use a host-appropriate driver. Cache is for replaceable values. It is not the source of truth for durable application data.

Read the [configuration reference](/docs/reference/config-options#vite-integration-options) and the [host guide](/docs/frameworks-hosts). The integration selects Cloudflare KV, Vercel runtime cache, Deno KV, or local filesystem storage from the host and options.

Keep cache keys, expiry, and invalidation in application code. A `nitro.kv` (`nitro.storage` in Nuxt) cache mount takes precedence over the ViteHub cache option. Netlify requires an explicit supported arrangement.

Prove a miss, a hit, expiry or invalidation, and the selected host output. Never use cache as the only copy of data that must survive eviction.
::

## Option placement

| Option kind | Belongs in | Example |
| --- | --- | --- |
| Integration Options | `vitehub()` or package integration call | Provider choice, generated output mode, project root. |
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
    host: "node",
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
      host: "node",
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
      host: "node",
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
    host: "node",
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
    host: "node",
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
  }), nitro()],
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
    host: "node",
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
  })],
})
```
:::
::

## Related

- [Vite](/docs/frameworks-hosts)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provisioning](/docs/development/provisioning)
- [Provider output](/docs/reference/provider-output)
