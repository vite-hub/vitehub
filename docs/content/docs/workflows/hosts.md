---
title: Workflows hosts
description: "Choose a Workflow Provider and storage per host: Cloudflare Workflows, Vercel, or OpenWorkflow with Postgres or SQLite."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { provider: 'cloudflare' }` | Workflow class, binding, and runtime entry. | Runs through Cloudflare Workflow bindings. Set `binding` and `name` to match existing resources. Without the binding, only `vite dev` runs the Workflow inline. A deployed Worker fails with `WORKFLOW_R0036`. |
| Vercel | `workflow: { provider: 'vercel' }` | Workflow runtime in the build output, on Vercel only. Other hosts get none. | A `native` entry uses Workflow DevKit for durable execution. The normal handler runs inline and stops if the function restarts. |
| OpenWorkflow | Inferred on Node and Docker, or `workflow: { provider: 'openworkflow' }` | A Nitro plugin that loads OpenWorkflow and starts its worker. | Uses the Postgres Default Database or `OPENWORKFLOW_POSTGRES_URL`, else a SQLite file. Set `postgres.url` or `sqlite.path`, not both. |

### Install Vercel dependencies

All Vercel Workflow definitions, including plain inline handlers, require `@vercel/functions` in the app:

```bash pm
pnpm add @vercel/functions
```

For [native durable definitions](/docs/workflows/configure#add-a-durable-vercel-entry), also install `workflow` and `@workflow/builders`. Plain inline handlers do not need these two packages.

### Upgrade the Vercel Workflow SDK

ViteHub uses `workflow` 5.2.3 and `@workflow/builders` 5.0.6. This has the `nanoid` security fix without the inline early-advance scheduling of Workflow 5.3.0. That scheduling can complete a run while a losing `Promise.race` step still runs, cut its retries short, and write its step events after `run_completed`. So ViteHub stays on 5.2.3.

Workflow 5.2.0 also fixes reuse of a hook after it loses a `Promise.race`. Runs that already took the timeout branch in that case may not replay after an in-place upgrade. Finish them with the old SDK before you upgrade the process that runs them.

> [!WARNING]
> For native workflows on the SDK's Local World in development, upgrading from the previous version (`workflow` 5.0.1) is a **destructive local reset**. The bundled `@workflow/world-local` 5.1.2 deletes run data in the older flat event/step layout on first start. It does not migrate it. The new SDK cannot inspect or resume those runs.

Before you start the new SDK:

1. Stop every process that uses that Local World.
2. Back up its whole data directory to a place outside it. The default is `.workflow-data`. `WORKFLOW_LOCAL_DATA_DIR` sets another location.
3. Finish the runs you need with the old SDK, or keep the backup and the old SDK to inspect and resume them.
4. To keep the old files, start the new SDK with `WORKFLOW_LOCAL_DATA_DIR` set to a separate, empty directory.

This reset affects Local World storage only, not runs in Vercel's hosted World.

### Select OpenWorkflow storage

OpenWorkflow resolves storage at runtime in this order:

1. `sqlite.path` selects SQLite, and `postgres.url` selects Postgres. Set only one. If its environment value is missing or empty, startup fails. It does not fall back to another store.
2. With neither set, `OPENWORKFLOW_SQLITE_PATH` selects SQLite.
3. Else `OPENWORKFLOW_POSTGRES_URL` selects Postgres.
4. Else, when the app has a Postgres Default Database (`server/databases/config.ts` with `dialect: 'postgresql'`), OpenWorkflow uses that Database's connection URL. A Database that connects through PG* variables only fails startup with `WORKFLOW_R0040`, so runs never go to a SQLite file by accident. `DATABASE_URL` alone is not used.
5. Else it uses `.vitehub/data/openworkflow.sqlite.db` in the process working directory, unless `DATABASE_URL` contains a Postgres URL (see the upgrade step below).

### Upgrade from DATABASE_URL storage

OpenWorkflow no longer selects Postgres from `DATABASE_URL` alone. Before upgrading an app that uses it, set `OPENWORKFLOW_POSTGRES_URL` or `workflow.postgres.url` to the **same Postgres URL**, or add a Postgres Default Database pointing to that database. Keep the existing schema and namespace so queued and sleeping runs remain visible to every server.

When `DATABASE_URL` starts with `postgres://` or `postgresql://` and no storage was selected above, storage resolution fails with `WORKFLOW_R0038` before either dispatch or the worker opens SQLite. Set the Postgres storage explicitly to resume those runs. To select local storage intentionally, set `workflow.sqlite.path` or `OPENWORKFLOW_SQLITE_PATH`. Other `DATABASE_URL` schemes, such as `libsql://`, do not trigger this diagnostic. `vite dev` still pins its local SQLite file unless `workflow.remote` is `true`.

> [!WARNING]
> The SQLite default needs a writable filesystem. Its state lives only as long as that file. A new container or a temporary function filesystem can lose it. Set up persistent storage before production. Keep staging and production storage or namespaces apart.

`workflow.database` is not supported and fails the config. It used to accept a Named Database without connecting OpenWorkflow to it. Use `workflow.postgres.url` or `workflow.sqlite.path` instead. Check where the old runtime really stored runs before you move them.

## Run Workflows on Node

With the `node` host, ViteHub selects OpenWorkflow. You do not configure a provider:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', workflow: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: true })],
})
```
:::
::

- `startWorkflow()` puts the run in storage and returns it with the status `queued`. A worker then executes it.
- Each server starts the OpenWorkflow worker when it has discovered Workflow files. Apps with only Agent or inline Workflows do not open OpenWorkflow storage or start its worker. On `SIGTERM`, the worker stops taking runs. A run that does not finish in the [drain budget](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) keeps its lease for 30 seconds. Then another worker takes it.
- With a Postgres Default Database, OpenWorkflow keeps its runs in that database, in the `openworkflow` schema. Without one, set `OPENWORKFLOW_POSTGRES_URL`. A `DATABASE_URL` alone is not used, the same as for Queue and Realtime. Without either, runs stay in `.vitehub/data/openworkflow.sqlite.db`, on one host only, and the server logs that at boot.
- Several servers can use the same Postgres database. When they start together, one server at a time creates the `openworkflow` schema. A server tries a Postgres advisory lock in a short transaction, and a server that does not get it waits without a connection. The server that gets it holds the lock until OpenWorkflow has set up the schema. OpenWorkflow migrates on its own connection, so that server needs two connections. When it gets no second connection in 10 seconds, for example behind a pooler with one server connection, it reports `WORKFLOW_R0037`, does not start the setup, and tries again later. Raise the pool size, or set up the schema once through a direct connection and then set `postgres.runMigrations: false`. OpenWorkflow takes each run with `FOR UPDATE SKIP LOCKED`, so only one worker executes it.
- When the storage is not ready, for example while Postgres starts, the server reports the error and tries again. The delay grows from 0.5 to 30 seconds. The server serves requests meanwhile, and queued runs wait in storage until the worker starts.
- `vite dev` also starts the worker, so runs complete on your computer. It keeps runs in `.vitehub/data/openworkflow.sqlite.db`, even with a Postgres Default Database or `OPENWORKFLOW_POSTGRES_URL` in `.env`, so a dev server never runs the runs of a shared database with local code. Set `workflow: { remote: true }` to use that database in `vite dev`. When you change a Workflow file, the dev server starts a new worker with the new code.

### Which Workflows are durable

Every worker registers the Workflow files that ViteHub discovers, such as `server/workflows/<name>.ts`, when it starts. Any worker can take a run, so only those Workflows go to OpenWorkflow. A Workflow that code creates while the server runs, such as `createWorkflow('name', handler)` or an Agent Workflow, runs inline in the request process instead. It is not durable, its run has `metadata.mode` set to `"inline"`, and the server logs a warning the first time. Move the Workflow to a file in `server/workflows/` to make it durable.

### Run the worker in its own process

Set `worker: false` when a separate process runs the Workflows. The web servers then only put runs in storage.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', workflow: { worker: false } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: { worker: false } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: { worker: false } })],
})
```
:::
::

The [Workflow package README](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker) shows the worker process. Give it the same storage as the servers.
