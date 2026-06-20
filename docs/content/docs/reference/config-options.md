---
title: Config options
description: Reference the main ViteHub Integration Options and where provider choices belong.
navigation.order: 53
icon: i-lucide-sliders-horizontal
---

Integration Options configure ViteHub package integrations.
Provider Selection belongs in Integration Options when it changes generated output, bindings, imports, or deployment behavior.

## Vite Integration options

| Package | Config key or plugin option | Main options |
| --- | --- | --- |
| Agent | `agent` or `hubAgent(options)` | `runtime`, `execution`, `imports`, `webhooks`, `devtools`, `cli`, `eval`, `integrations`, `providers`. |
| Auth | `hubAuth(options)` | Enable or disable the integration; Auth Definition owns Better Auth options. |
| Blob | `blob` or `hubBlob(options)` | Blob Store config, named stores, provider driver selection. |
| Database | `database` or `hubDb(options)` | `driver`, Cloudflare D1 fields, local runtime fields, `cli.generate`, `cli.migrate`. |
| DevTools | `hubDevtools(options)` | DevTools Client shell URL and hosted/local shell behavior. |
| Env | `hubEnv(options)` and `env` config | `prefix`, `projectRoot`, `diagnostics`, plus `env.public`, `env.define`, and `env.server`. |
| KV | `kv` or `hubKv(options)` | `fs-lite`, `cloudflare-kv-binding`, or `upstash` store config; named stores. |
| Queue | `queue` or `hubQueue(options)` | `provider`, `binding`, `region`, cache behavior. |
| Sandbox | `sandbox` or `hubSandbox(options)` | `provider`, `binding`, class name, sandbox name, provider reuse options. |
| Schedule | `hubSchedule(options)` | `providerOutput`, `projectRoot`. |
| Workflow | `workflow` or `hubWorkflow(options)` | `provider`, `binding`, OpenWorkflow database config, worker config. |
| Workspace | `workspace` or `hubWorkspace(options)` | `root`, `projectRoot`, `assets`, Workspace Store config. |

## Option placement

| Option kind | Belongs in | Example |
| --- | --- | --- |
| Integration Options | Vite config or package integration call | Provider Selection, generated output mode, project root. |
| Definition Options | Definition Boundary Helper file | Queue concurrency, Database tables, Workspace Sources and rules. |
| Invocation Options | Runtime Helper call | Sandbox Identity, Agent input options, schedule creation input. |
| Runtime Env | Env Package Server Env | Provider tokens, app secrets, request-time runtime values. |

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
