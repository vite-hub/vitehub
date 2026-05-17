---
title: OpenWorkflow
description: Configure @vitehub/workflow for Docker and Node deployments with OpenWorkflow and Postgres.
navigation.title: OpenWorkflow
navigation.group: Providers
navigation.order: 2
icon: i-lucide-container
frameworks: [nitro]
---

Use the OpenWorkflow provider when a Nitro app runs as a Node server in Docker or on a VPS. Cloudflare and Vercel keep their native providers; Nitro `node-server` builds infer OpenWorkflow automatically.

Install the runtime dependencies in the application:

```sh
pnpm add openworkflow postgres
```

Configure Workflow directly or use the Node/Docker runtime preset from `@vitehub/agent/nitro` when the app also uses ViteHub Chat:

```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/workflow/nitro'],
  preset: 'node-server',
  workflow: {
    provider: 'openworkflow',
    postgres: {
      url: process.env.OPENWORKFLOW_POSTGRES_URL,
      namespaceId: process.env.OPENWORKFLOW_NAMESPACE_ID || 'production',
      schema: process.env.OPENWORKFLOW_SCHEMA || 'openworkflow',
    },
    worker: {
      concurrency: 10,
    },
  },
})
```

```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { nodeDockerRuntimePreset } from '@vitehub/agent/nitro'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

const runtime = nodeDockerRuntimePreset()

export default defineConfig({
  plugins: [
    hubAgent(runtime.chat),
    nitro({
      ...runtime,
      modules: ['@vitehub/agent/nitro', '@vitehub/workflow/nitro'],
    }),
  ],
})
```

`provider: 'node'` is accepted as an alias for `openworkflow`.

## Runtime model

OpenWorkflow stores run state and step history in Postgres. The web app starts workflows by writing runs to the database. One or more worker processes poll Postgres, claim work, execute workflow handlers, and persist completed steps.

The provider maps ViteHub workflow steps onto OpenWorkflow `step.run()` checkpoints, so repeated worker starts do not repeat completed steps.

Nitro starts an OpenWorkflow worker in the same Node process by default for `openworkflow` configs. Set `OPENWORKFLOW_WORKER=false` on the web app when running a separate worker process.

## Worker entry

Create a small worker entry in the application that imports the generated workflow registry and starts the worker. Bundle this entry with the same Nitro/Vite aliases as the app so `#vitehub/workflow/registry` resolves to the generated registry.

```ts [worker.ts]
import workflowRegistry from '#vitehub/workflow/registry'
import { startOpenWorkflowWorker } from '@vitehub/workflow/runtime/openworkflow-worker'

await startOpenWorkflowWorker({
  config: {
    provider: 'openworkflow',
    postgres: {
      url: process.env.OPENWORKFLOW_POSTGRES_URL,
      namespaceId: process.env.OPENWORKFLOW_NAMESPACE_ID || 'production',
      schema: process.env.OPENWORKFLOW_SCHEMA || 'openworkflow',
    },
    worker: {
      concurrency: Number(process.env.OPENWORKFLOW_WORKER_CONCURRENCY || 10),
    },
  },
  registry: workflowRegistry,
})
```

Run it in a separate Docker service alongside the Nitro server:

```yaml [docker-compose.yml]
services:
  app:
    command: node .output/server/index.mjs
    environment:
      OPENWORKFLOW_WORKER: "false"
      OPENWORKFLOW_POSTGRES_URL: postgres://postgres:postgres@postgres:5432/app

  workflow-worker:
    command: node worker.mjs
    environment:
      OPENWORKFLOW_POSTGRES_URL: postgres://postgres:postgres@postgres:5432/app

  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
```

## Environment

| Variable | Use |
| --- | --- |
| `OPENWORKFLOW_POSTGRES_URL` | Primary Postgres connection URL. |
| `DATABASE_URL` | Fallback Postgres connection URL. |
| `OPENWORKFLOW_NAMESPACE_ID` | Namespace for isolating environments. Defaults to `production`. |
| `OPENWORKFLOW_SCHEMA` | Postgres schema for workflow tables. Defaults to `openworkflow`. |

OpenWorkflow runs migrations on connect by default. Set `postgres.runMigrations: false` when migrations are managed separately.

Use `openWorkflowEnv()` from `@vitehub/env/nitro` if the app wants runtime env diagnostics for these variables:

```ts
import { env, openWorkflowEnv } from '@vitehub/env/nitro'

env: {
  databaseUrl: env({ secret: true, source: env.source('DATABASE_URL') }),
  openWorkflow: openWorkflowEnv(),
}
```
