---
title: Config options
description: Reference the main ViteHub Integration Options and where provider choices belong.
navigation.order: 55
icon: i-lucide-sliders-horizontal
---

Integration Options configure ViteHub package integrations.
Provider Selection belongs in Integration Options when it changes generated output, bindings, imports, or deployment behavior.

## Built-in deployment preset

`vitehub()` requires exactly one built-in `preset`: `cloudflare`, `netlify`, `vercel`, `deno`, or `node`. The selection is the single source for host identity, runtime, Nitro output, packaging, and built-in Blob, Queue, Rate Limit, and Sandbox adapters. Conflicting Nitro or hosting environment selections fail configuration.

`name` is ViteHub's logical deployment identity. Cloudflare Workers Builds supplies its connected Worker through `WRANGLER_CI_OVERRIDE_NAME`, which the Cloudflare preset resolves below explicit `name` and above the nearest `package.json` name and Vite root directory name. A differing explicit ViteHub identity fails because the connected Worker remains the deployment target. Cloudflare uses the resolved identity for default Worker, Blob bucket, Queue prefix, Rate Limit namespace, Sandbox, and Container names. Explicit Wrangler Worker names remain authoritative outside Workers Builds, while explicit Blob bucket, driver, or store options still win. This fallback derives deterministic names but does not provision the corresponding R2 bucket or Queue. The generated deployment manifest records the resolved identity and its source.

| Import | Public type | Placement | Defaults |
| --- | --- | --- | --- |
| `vite-hub` | `ViteHubOptions` | `vitehub({ preset })` in Vite `plugins` | Composes Env. Agent, Auth, Blob, Browser, Channels, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace are enabled with `true` or explicit options. On Cloudflare, Email also supports `true`; other presets reject the Cloudflare-only default. |

Unsupported requested capabilities fail before a production build can silently select a weaker provider. The `node` preset intentionally exposes its filesystem Blob store as single-host and its memory Rate Limiter as single-process. The `deno` preset rejects Schedule and `agent.runtime: "deno"` because those generated servers are not part of its deployed Nitro entrypoint. Deno output includes runtime package staging, a validated deployment manifest, and a non-interactive create-or-update runner.

Direct `hubX()` integration functions remain available from their independent
`@vite-hub/*/vite` owner-package paths.

The root `vitehub()` facade enables Agent, Blob, Browser, Channels, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace with `true`. Email accepts `true` with the Cloudflare preset, where it selects the Cloudflare Email driver; other presets reject that boolean default and require explicit provider options. Direct owner-package integrations retain their detailed option types. Auth follows the same opt-in shape but currently has no plugin option bag.

## Vite Integration options

| Package | Public type | Placement | Confirmed options and defaults |
| --- | --- | --- | --- |
| Agent | `AgentModuleOptions` | `agent` config key or `hubAgent(options)` | Omission or `false` disables Agent in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `runtime`: `auto`, `cloudflare-agents`, `deno`, `unknown`, `vercel`, `vite`; default `auto`. `execution`: `inline`, `sandbox`, `workflow`; default `inline`. `imports` defaults to `true`. `integrations.sandbox` and `integrations.workflow` default to `auto`. Provider groups `sandbox`, `scheduler`, and `state` default to provider `auto`. Automatic state uses Cloudflare state on Cloudflare and local SQLite at `file:.vitehub/data/agent-state.sqlite` during Vite development; production output requires a durable `VITEHUB_AGENT_STATE_URL` or explicit provider options. Hosted Agent Definitions mount `/api/_vitehub/agents/[agent]/chat`; each Agent's route-enabled Channel controls whether it answers. Webhook routes remain Channel-owned and available for adapter delivery. Set `routes.discordGateway` to generate the Discord Gateway listener route; `true` selects the package default route. `routes.inspection` is disabled by default; `true` mounts `/api/_vitehub/agents/[agent]/inspection`, while a string selects a custom route. Inspection includes operational metadata and does not add authorization. The host must authorize the route before ViteHub resolves the Agent. |
| Auth | `AuthModuleOptions` | `auth` config key or `hubAuth(options)` | `false` disables the integration. The enabled integration has no plugin option bag yet. `defineAuth()` owns `basePath` default `/api/auth`, `route: false`, `access`, `database`, `secondaryStorage`, and `runtime`. |
| Blob | `BlobModuleOptions` | `blob` config key or `hubBlob(options)` | Omission or `false` disables Blob in `vitehub()`; `true` enables the selected preset's store, and an options object enables and configures it. Driver literals include `fs`, `cloudflare-r2`, `netlify-blobs`, `vercel-blob`, `minio`, `s3`, `gcs`, `azure`, and other exported Blob drivers. Defaults: Cloudflare hosting selects `cloudflare-r2` binding `BLOB`; Netlify hosting selects `netlify-blobs`; `BLOB_READ_WRITE_TOKEN` or Vercel hosting selects `vercel-blob` with `access: "public"`; otherwise the integration selects `fs` at `.vitehub/data/blob`. MinIO defaults to bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true`. |
| Browser | `BrowserModuleOptions` | `browser` config key or `hubBrowser(options)` | Omission or `false` disables Browser in `vitehub()`; `true` enables Cloudflare Browser Run actions with binding `BROWSER`, `{ binding }` changes the binding name, and `remote: true` connects local Wrangler development to the hosted service. Browser Definitions currently require the Cloudflare preset. The root integration and direct standalone `hubBrowser()` output generate the binding and required compatibility fields while preserving unrelated Wrangler fields. |
| Channels | `ChannelsVitePluginOptions` | `channels` config key or `hubChannels(options)` | Omission or `false` disables Channel discovery in `vitehub()`; `true` discovers `server/channels/<path>.ts` and `<path>.channel.ts`. `projectRoot` changes where ViteHub looks for those files. Connectors and provider credentials belong in the Channel Definition. |
| Console | `boolean \| ConsoleOptions` | `console` config key in `vitehub()` | Omission or `false` registers no Console page, API handler, plugin, or assets. `true` mounts the complete read-only [Console](/docs/development/console) during development. Production Node builds require `{ access: 'auth' }` with callback-backed Auth policies for `/_vitehub/**` and `/api/_vitehub/console/**`, or `{ exposure: 'host-managed' }` to acknowledge equivalent host middleware. The Console uses a fallback SQLite invocation journal at `.vitehub/data/console.sqlite`. |
| Database | `DBModulePublicOptions` | `database` config key or `hubDb(options)` | Omission or `false` disables Database in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `projectRoot` sets the Database discovery, generated-artifact, and provisioning root; relative paths resolve from the Vite root in Vite and the Nuxt `rootDir` in Nuxt. Integration options are `cli.generate` and `cli.migrate`, each disableable with `false`. `connection` supplies a hosted libSQL default for Vercel and other hosted output. Cloudflare D1 runtime fields are `driver: "d1"`, `binding`, `databaseId`, `previewDatabaseId`, `databaseName`, `migrationsTable`, and `local.filename`. Database Definitions own tables and may override integration connection values. |
| Email | `EmailVitePluginOptions` | `email` config key or `hubEmail(options)` | `driver` is `resend` or `cloudflare-email`; `options` accepts serializable literals and runtime Env declarations. Omission disables Email in `vitehub()`. The root package also accepts `email: true` on Cloudflare and rejects it on other presets. Markdown under `server/emails/**/*.md` is discovered recursively and exposed through typed `#vitehub/emails/<name>` renderer imports. |
| Env | `EnvIntegrationOptions` and `EnvViteConfigOptions` | `hubEnv(options)` plus Vite `env` config | `diagnostics`: `off`, `summary`, `trace`; default `summary`. `prefix` changes inferred environment variable names. `projectRoot` changes generated file placement. Vite `env.public`, `env.define`, and `env.server` own Public Env, build define values, and Server Env declarations. |
| KV | `KVModuleOptions` | `kv` config key or `hubKv(options)` | Accepts `false`, one store config, or `{ stores }` with `stores.default`. Driver literals are `fs-lite`, `cloudflare-kv-binding`, `deno-kv`, and `upstash`. Defaults: Deno hosting selects `deno-kv`; Upstash env selects `upstash`; Vercel hosting selects `upstash`; Cloudflare hosting selects `cloudflare-kv-binding` binding `KV`; otherwise `fs-lite` at `.vitehub/data/kv`. |
| Queue | `QueueModuleOptions` | `queue` config key or `hubQueue(options)` | `false` disables the integration. When active, `provider` is `cloudflare` or `vercel`; Cloudflare hosting selects `cloudflare`, and other supported hosts select `vercel`. Netlify does not infer a provider. Shared `cache` belongs here. Cloudflare uses `binding`; Vercel uses `region`. Queue concurrency and retry behaviour belong to Queue Definition or enqueue options. |
| Rate Limit | `RateLimitVitePluginOptions` | `rateLimit` config key or `hubRateLimit(options)` | `provider`: `auto`, `cloudflare`, or `memory`; default `auto`. Auto selects memory for Vite serve and Cloudflare for a known Cloudflare production host. Cloudflare requires a deployment-unique `namespace`. `projectRoot` and `scanDirs` are source-collection escape hatches. Handler-local `requireRateLimit()` calls own static limits, windows, enforcement guarantees, and failure behavior. |
| Realtime | `RealtimeModuleOptions` | `realtime` config key or `hubRealtime(options)` | `authority`: `auto`, `cloudflare`, or `memory`; default `auto`. Auto uses a Durable Object when Realtime can resolve a Cloudflare Nitro preset or hosting environment. With only `vitehub({ preset: 'cloudflare' })` during Vite development, set `authority: 'cloudflare'` explicitly. Other development presets fall back to process memory. Other production builds require an explicit authority; `memory` is accepted only for a single-process server. Realtime Definitions keep the engine and document format separate from this deployment choice. |
| Sandbox | `SandboxPublicOptions` | `sandbox` config key or `hubSandbox(options)` | `false` disables the integration. Provider selection belongs here: `cloudflare`, `vercel`, or inferred provider options. Netlify requires an explicit provider when Sandbox is active. Cloudflare defaults are binding `SANDBOX`, class name `Sandbox`, and migration tag `v1`. Per-run sandbox identity belongs to Sandbox Run invocation options. |
| Schedule | `ScheduleVitePluginOptions` | `hubSchedule(options)` | `providerOutput`: `auto`, `standalone`, `nitro`, or `false`; default `auto`. `projectRoot` changes where generated schedule output is written. There is no public `schedule.provider` option. |
| Workflow | `WorkflowModuleOptions` | `workflow` config key or `hubWorkflow(options)` | Omission or `false` disables Workflow in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `provider`: `cloudflare`, `openworkflow`, or `vercel`. Cloudflare hosting selects `cloudflare`; Node or Docker with OpenWorkflow storage config selects `openworkflow`; other supported hosts select `vercel`. Netlify does not infer a provider. Shared fields are `binding` and `name`. OpenWorkflow fields are `database`, `postgres`, `sqlite`, and `worker.concurrency`. |
| Workspace | `WorkspaceModuleOptions` | `workspace` config key or `hubWorkspace(options)` | Omission or `false` disables Workspace in `vitehub()`; `true` enables inferred defaults, and an options object enables and configures it. `root` defaults to `.vitehub/workspaces`. `projectRoot` changes source root resolution. `assets` controls build-time asset generation. `store` provider literals are `local`, `memory`, `cloudflare-artifacts`, `vercel-blob`, and `github`. Explicit `cloudflare-artifacts` selection generates its Cloudflare binding. Defaults: local development uses `local`; Cloudflare hosting uses `memory`; `BLOB_READ_WRITE_TOKEN` selects `vercel-blob`; Vercel hosting without Blob env uses `memory`; otherwise `local`. |

## Option placement

| Option kind | Belongs in | Example |
| --- | --- | --- |
| Integration Options | Vite config or package integration call | Provider Selection, generated output mode, project root. |
| Definition Options | Definition Boundary Helper file | Queue concurrency, Database tables, Workspace Sources and rules. |
| Invocation Options | Runtime Helper call | Sandbox Identity, Agent input options, schedule creation input. |
| Runtime Env | Env Package Server Env | Provider tokens, app secrets, request-time runtime values. |

Provider-specific driver fields are intentionally summarized here. Read the exported package types when configuring a deep provider adapter, and keep provider choices in Integration Options unless the owning package documents an invocation-time option.

## Agent eval options

Agent Eval Runner defaults live under the Agent Package integration.

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

## Env options

Env separates Public Env, compile-time define values, and Server Env.
Secret Env values belong in `env.server`, not `env.public` or `env.define`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({ preset: "node", env: { diagnostics: 'summary' } })],
  env: {
    public: {
      appName: env({ default: 'Acme', mode: 'build' }),
    },
    server: {
      apiToken: env({ secret: true, source: env.source('API_TOKEN') }),
    },
  },
})
```

## Related

- [Vite](/docs/frameworks-hosts)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provisioning](/docs/development/provisioning)
- [Provider output](/docs/reference/provider-output)
