---
title: Workflows hosts
description: "Choose a Workflow Provider and storage per host: Cloudflare Workflows, Vercel, or OpenWorkflow with Postgres or SQLite."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Drivers

| Host | Driver without `driver` |
| --- | --- |
| Cloudflare | Cloudflare |
| Vercel | Vercel |
| Netlify | None. Set `driver`. |
| Node and Docker, including `vite dev` with the Node host | OpenWorkflow, with an automatic worker |
| Deno and other hosts | OpenWorkflow when you set `postgres.url` or `sqlite.path`. Else the build fails with `WORKFLOW_C0020`. |
| `vite dev` on a host without a provider | Inline runs in the dev server |

ViteHub infers Vercel only on Vercel. `agent: true` does not turn on Workflow: without `workflow`, Agents run inline, and a restart loses their runs. With `workflow: true` on Node and Docker, Agent turns are OpenWorkflow runs, so they survive a restart. On Node and Docker, an app without discovered Workflows or Agents starts no worker. `vitehub durability list` shows the store that the app uses.


| Driver | Configure with | Driver output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { driver: 'cloudflare' }` | Workflow class, binding, and runtime entry. | Runs through Cloudflare Workflow bindings. Set `binding` and `name` to match existing resources. Without the binding, only `vite dev` runs the Workflow inline. A deployed Worker fails with `WORKFLOW_R0036`. |
| Vercel | `workflow: { driver: 'vercel' }` | Workflow runtime in the build output, on Vercel only. Other hosts get none. With Nitro or Nuxt, Nitro's server function installs the Workflows, so routes can start them. Native entries also get the Workflow DevKit functions. | A `native` entry uses Workflow DevKit for durable execution. The normal handler runs inline and stops if the function restarts. |
| OpenWorkflow | Inferred on Node and Docker, or `workflow: { driver: 'openworkflow' }` | A Nitro plugin that loads OpenWorkflow and starts its worker. | Uses the Postgres Default Database or `OPENWORKFLOW_POSTGRES_URL`, else a SQLite file. Set `postgres.url` or `sqlite.path`, not both. |

### Install Vercel dependencies

All Vercel Workflow definitions, including plain inline handlers, require `@vercel/functions` in the app:

```bash pm
pnpm add @vercel/functions
```

For [native durable definitions](/docs/workflows/configure#add-a-durable-vercel-entry), also install `workflow` and `@workflow/builders`. A Workflow folder is native too. Plain inline handlers do not need these two packages. When a native definition misses them, the build stops with `WORKFLOW_R0006` and prints the install command.

```bash pm
pnpm add --save-exact workflow@5.2.3 @workflow/builders@5.0.6
```

### Upgrade the Vercel Workflow SDK

ViteHub accepts `workflow` 5.2.3 or a later 5.x, and `@workflow/builders` 5.0.6 or a later 5.x. An exact version would make npm stop with `ERESOLVE` when the app or another package needs a newer 5.x.

ViteHub tests with `workflow` 5.2.3 and `@workflow/builders` 5.0.6, and the install commands use these versions. 5.2.3 is the first version with the `nanoid` security fix. `workflow` 5.5.0 with `@workflow/builders` 5.1.0 also passes the Workflow package tests.

Workflow 5.3.0 and later change how a run ends. The run completes as soon as the workflow function returns, even while a losing `Promise.race` step still runs. That step gets only its current attempt, and its step events can come after `run_completed`. Workflow 5.5.0 removes the `WORKFLOW_INLINE_EARLY_ADVANCE` setting that turned this off. The entry that ViteHub generates for a folder runs its steps one after the other, so the change does not affect it. Check your own `native` entries that use `Promise.race` before you install 5.3.0 or later. `pnpm add workflow` without a version installs the latest 5.x, which has this behavior.

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
4. Else, when the app has a Postgres Default Database (`server/databases/config.ts` with `dialect: 'postgresql'`), OpenWorkflow uses that Database's connection URL. A Database that connects through PG* variables only fails startup with `WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING`, so runs never go to a SQLite file by accident. `DATABASE_URL` alone is not used.
5. Else it uses `.vitehub/data/openworkflow.sqlite.db` in the process working directory, unless `DATABASE_URL` contains a Postgres URL (see below).

### `DATABASE_URL` is not read

OpenWorkflow does not select Postgres from `DATABASE_URL`. When `DATABASE_URL` starts with `postgres://` or `postgresql://` and no step above selected storage, startup fails with `WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED` before dispatch or the worker opens SQLite. To keep runs in that database, set `OPENWORKFLOW_POSTGRES_URL` or `workflow.postgres.url` to the same URL, or add a Postgres Default Database for it. To use SQLite, set `workflow.sqlite.path` or `OPENWORKFLOW_SQLITE_PATH`. Other `DATABASE_URL` schemes, such as `libsql://`, do not cause this error. `vite dev` still uses its local SQLite file unless `workflow.remote` is `true`.

> [!WARNING]
> The SQLite default needs a writable filesystem. Its state lives only as long as that file. A new container or a temporary function filesystem can lose it. Set up persistent storage before production. Keep staging and production storage or namespaces apart.

`workflow.database` is not an option, and the config fails with it. Use `workflow.postgres.url` or `workflow.sqlite.path`.

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
- Each server starts the OpenWorkflow worker when it has discovered Workflow or Agent files. Apps with only inline Workflows do not open OpenWorkflow storage or start its worker.
- A worker executes 10 runs at once. Set `worker: { concurrency }` to change it. Each Agent turn uses two runs: the turn, and a recovery run that waits for the turn to end. On `SIGTERM`, the worker stops taking runs. A run that does not finish in the [drain budget](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) keeps its lease for 30 seconds. Then another worker takes it.
- With a Postgres Default Database, OpenWorkflow keeps its runs in that database, in the `openworkflow` schema. Without one, set `OPENWORKFLOW_POSTGRES_URL`. A `DATABASE_URL` alone is not used, the same as for Queue and Realtime. Without either, runs stay in `.vitehub/data/openworkflow.sqlite.db`, on one host only, and the server logs that at boot.
- Several servers can use the same Postgres database. When they start together, one server at a time creates the `openworkflow` schema. A server tries a Postgres advisory lock in a short transaction, and a server that does not get it waits without a connection. The server that gets it holds the lock until OpenWorkflow has set up the schema. OpenWorkflow migrates on its own connection, so that server needs two connections. When it gets no second connection in 10 seconds, for example behind a pooler with one server connection, it reports `WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE`, does not start the setup, and tries again later. Raise the pool size, or set up the schema once through a direct connection and then set `postgres.runMigrations: false`. OpenWorkflow takes each run with `FOR UPDATE SKIP LOCKED`, so only one worker executes it.
- When the storage is not ready, for example while Postgres starts, the server reports the error and tries again. The delay grows from 0.5 to 30 seconds. The server serves requests meanwhile, and queued runs wait in storage until the worker starts.
- `vite dev` also starts the worker, so runs complete on your computer. It keeps runs in `.vitehub/data/openworkflow.sqlite.db`, even with a Postgres Default Database or `OPENWORKFLOW_POSTGRES_URL` in `.env`, so a dev server never runs the runs of a shared database with local code. Set `workflow: { remote: true }` to use that database in `vite dev`. When you change a Workflow file, the dev server starts a new worker with the new code.

### Which Workflows are durable

Every worker registers the Workflow files that ViteHub discovers, such as `server/workflows/<name>.ts`, and the Agents in `server/agents/`, when it starts. Any worker can take a run, so only those Workflows go to OpenWorkflow. The startup registry also installs the generated Agent State resolver and Capability loaders, so a fresh worker can restore persisted Channel deliveries without loading an Agent route first.

- An Agent turn is an OpenWorkflow run. Any server's worker can execute it. A turn that waits in storage runs after a restart. Inspect it with `getWorkflowRun()`, `vitehub workflow get <id> --workflow <agent>`, or the Agent journal. A turn that stops during its Driver fails and does not run the Driver again. See [Recover after a restart](/docs/agents/invocations#recover-after-a-restart).
- A turn of an Agent that is not discovered fails with `WORKFLOW_AGENT_NOT_DISCOVERED`, because no worker can run it. Move the Agent to `server/agents/`, or call `runAgent()` to run it without a Workflow.
- A Workflow that code creates while the server runs, such as `createWorkflow('name', handler)`, runs inline in the request process. It is not durable, its run has `metadata.mode` set to `"inline"`, and the server logs a warning the first time. Move the Workflow to a file in `server/workflows/` to make it durable.

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
