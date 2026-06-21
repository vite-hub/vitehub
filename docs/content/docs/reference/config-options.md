---
title: Config options
description: Reference the main ViteHub Integration Options and where provider choices belong.
navigation.order: 53
icon: i-lucide-sliders-horizontal
---

Integration Options configure ViteHub package integrations.
Provider Selection belongs in Integration Options when it changes generated output, bindings, imports, or deployment behavior.

## Preset options

| Import | Public type | Placement | Defaults |
| --- | --- | --- | --- |
| `@vite-hub/vite` | `ViteHubPresetOptions` | `vitehub(options)` in Vite `plugins` | Enables Agent, Blob, Database, DevTools, Env, KV, Queue, Sandbox, Schedule, Workflow, and Workspace integrations unless that key is `false`. |

## Vite Integration options

| Package | Public type | Placement | Confirmed options and defaults |
| --- | --- | --- | --- |
| Agent | `AgentModuleOptions` | `agent` config key or `hubAgent(options)` | `runtime`: `auto`, `cloudflare-agents`, `deno`, `unknown`, `vercel`, `vite`; default `auto`. `execution`: `inline`, `sandbox`, `workflow`; default `inline`. `imports` defaults to `true`. `integrations.sandbox` and `integrations.workflow` default to `auto`. Provider groups `sandbox`, `scheduler`, and `state` default to provider `auto`. `routes.chat` and `routes.webhooks` are disabled unless set to `true` or a route string; `true` uses `/api/_vitehub/agents/[agent]/chat` and `/api/_vitehub/agents/[agent]/webhooks/[webhook]`. |
| Auth | `AuthModuleOptions` | `auth` config key or `hubAuth(options)` | `false` disables the integration. The enabled integration has no plugin option bag yet. `defineAuth()` owns `basePath` default `/api/auth`, `route: false`, `access`, `database`, `secondaryStorage`, and `runtime`. |
| Blob | `BlobModuleOptions` | `blob` config key or `hubBlob(options)` | Accepts `false`, one `BlobStoreConfig`, or `{ stores }` with `stores.default`. Driver literals include `fs`, `cloudflare-r2`, `vercel-blob`, `minio`, `s3`, `gcs`, `azure`, and other exported Blob drivers. Defaults: Cloudflare hosting selects `cloudflare-r2` binding `BLOB`; Vercel hosting or `BLOB_READ_WRITE_TOKEN` selects `vercel-blob` with `access: "public"`; otherwise `fs` at `.data/blob`. MinIO defaults to bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true`. |
| Database | `DBModulePublicOptions` | `database` config key or `hubDb(options)` | `false` disables the integration. Integration options are `cli.generate` and `cli.migrate`, each disableable with `false`. Cloudflare D1 runtime fields are `driver: "d1"`, `binding`, `databaseId`, `previewDatabaseId`, `databaseName`, `migrationsTable`, and `local.filename`. Database Definitions own tables and per-database Cloudflare binding metadata. |
| DevTools | `HubDevtoolsOptions` | `hubDevtools(options)` | `enabled: false` disables the shell. `url` defaults to `VITEHUB_DEVTOOLS_URL` or `/__vitehub/devtools/`. `title` defaults to `ViteHub`; `icon` is passed to the Vite DevTools dock entry. |
| Env | `EnvIntegrationOptions` and `EnvViteConfigOptions` | `hubEnv(options)` plus Vite `env` config | `diagnostics`: `off`, `summary`, `trace`; default `summary`. `prefix` changes inferred environment variable names. `projectRoot` changes generated file placement. Vite `env.public`, `env.define`, and `env.server` own Public Env, build define values, and Server Env declarations. |
| KV | `KVModuleOptions` | `kv` config key or `hubKv(options)` | Accepts `false`, one store config, or `{ stores }` with `stores.default`. Driver literals are `fs-lite`, `cloudflare-kv-binding`, `deno-kv`, and `upstash`. Defaults: Deno hosting selects `deno-kv`; Upstash env selects `upstash`; Vercel hosting selects `upstash`; Cloudflare hosting selects `cloudflare-kv-binding` binding `KV`; otherwise `fs-lite` at `.data/kv`. |
| Queue | `QueueModuleOptions` | `queue` config key or `hubQueue(options)` | `false` disables the integration. `provider`: `cloudflare` or `vercel`; default is `cloudflare` on Cloudflare hosting and `vercel` otherwise. Shared `cache` belongs here. Cloudflare uses `binding`; Vercel uses `region`. Queue concurrency and retry behavior belong to Queue Definition or enqueue options. |
| Sandbox | `SandboxPublicOptions` | `sandbox` config key or `hubSandbox(options)` | `false` disables the integration. Provider selection belongs here: `cloudflare`, `vercel`, or inferred provider options. Cloudflare defaults are binding `SANDBOX`, class name `Sandbox`, and migration tag `v1`. Per-run sandbox identity belongs to Sandbox Run invocation options. |
| Schedule | `ScheduleVitePluginOptions` | `hubSchedule(options)` | `providerOutput`: `auto`, `standalone`, `nitro`, or `false`; default `auto`. `projectRoot` changes where generated schedule output is written. There is no public `schedule.provider` option. |
| Workflow | `WorkflowModuleOptions` | `workflow` config key or `hubWorkflow(options)` | `false` disables the integration. `provider`: `cloudflare`, `openworkflow`, or `vercel`. Defaults: Cloudflare hosting selects `cloudflare`; Node or Docker with OpenWorkflow storage config selects `openworkflow`; otherwise `vercel`. Shared fields are `binding` and `name`. OpenWorkflow fields are `database`, `postgres`, `sqlite`, and `worker.concurrency`. |
| Workspace | `WorkspaceModuleOptions` | `workspace` config key or `hubWorkspace(options)` | `root` defaults to `.vitehub/workspaces`. `projectRoot` changes source root resolution. `assets` controls build-time asset generation. `store` provider literals are `local`, `memory`, `cloudflare-artifacts`, `vercel-blob`, and `github`. Defaults: local development uses `local`; Cloudflare hosting uses `memory`; `BLOB_READ_WRITE_TOKEN` selects `vercel-blob`; Vercel hosting without Blob env uses `memory`; otherwise `local`. |

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
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      eval: {
        cache: true,
        maxConcurrency: 2,
        scoreThreshold: 0.85,
        testTimeout: 60_000,
      },
    }),
  ],
})
```

## Env options

Env separates Public Env, compile-time define values, and Server Env.
Secret Env values belong in `env.server`, not `env.public` or `env.define`.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv({ diagnostics: 'summary' })],
  env: {
    public: {
      appName: env({ default: 'Acme' }),
    },
    server: {
      apiToken: env({ secret: true, source: env.source('API_TOKEN') }),
    },
  },
})
```

## Related

- [Vite](/docs/frameworks-hosts)
- [Provisioning](/docs/development/provisioning)
- [Provider output](/docs/reference/provider-output)
