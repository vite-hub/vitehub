---
title: Workflows hosts
description: "Select a Workflow Provider and its storage for each host: Cloudflare Workflows, Vercel, or OpenWorkflow with Postgres or SQLite."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { provider: 'cloudflare' }` | Cloudflare Workflow class, binding, and runtime entry output. | Runs through Cloudflare Workflow bindings. Use `binding` and `name` when the generated names must match existing infrastructure. |
| Vercel | `workflow: { provider: 'vercel' }` | Vercel workflow runtime output under the build output, when the host is Vercel. Other hosts get no Vercel output. | A `native` entry uses Workflow DevKit for durable execution. The normal handler runs inline and does not survive a function restart. |
| OpenWorkflow | Inferred on Node and Docker, or `workflow: { provider: 'openworkflow' }` | A Nitro plugin that loads OpenWorkflow from the server bundle and starts its worker. | Uses Postgres when `DATABASE_URL` or `OPENWORKFLOW_POSTGRES_URL` is set at runtime, else a SQLite file. Configured `postgres.url` and `sqlite.path` are mutually exclusive. |

### Upgrade the Vercel Workflow SDK

The Workflow catalog uses `workflow` 5.2.3 and `@workflow/builders` 5.0.6. This includes the `nanoid` security fix without enabling Workflow 5.3.0's inline early-advance scheduling. That scheduling can complete a run while a losing `Promise.race` step is still executing, curtail its retries, and write its step events after `run_completed`, so this upgrade stays on 5.2.3.

Workflow 5.2.0 also fixes reusing a hook after it loses a `Promise.race`. Runs that already took the timeout branch in that situation may fail to replay after an in-place upgrade. Finish those runs with the old SDK before upgrading the process that executes them.

For native workflows using the SDK's Local World during development, upgrading from the previous catalog version (`workflow` 5.0.1) is a **destructive local reset**. The bundled `@workflow/world-local` 5.1.2 deletes run data from the older flat event/step layout on first startup; it does not migrate it. Those runs can no longer be inspected or resumed with the new SDK.

Before starting the updated SDK, stop every process using that Local World and back up its entire data directory outside that directory. The default is `.workflow-data`; `WORKFLOW_LOCAL_DATA_DIR` selects another location. Finish runs you need to retain with the old SDK before upgrading, or keep the backup with the old SDK for inspection and resumption. Start the new SDK with `WORKFLOW_LOCAL_DATA_DIR` pointing to a separate, empty directory to preserve the old files. This reset affects Local World storage, not runs stored by Vercel's hosted World.

### Select OpenWorkflow storage

OpenWorkflow resolves storage at runtime in this order:

1. An explicit `sqlite.path` selects SQLite; an explicit `postgres.url` selects Postgres. Configure only one. If its runtime environment declaration is missing or empty, startup fails instead of selecting another store.
2. With neither option configured, `OPENWORKFLOW_SQLITE_PATH` selects SQLite.
3. Otherwise, `OPENWORKFLOW_POSTGRES_URL` selects Postgres.
4. Otherwise, when the app has a Postgres Default Database (`server/databases/config.ts` with `dialect: 'postgresql'`), OpenWorkflow uses the same connection URL as that Database. When that Database connects through PG* environment variables only, startup fails with `WORKFLOW_R0036`, so runs never go to a SQLite file by accident.
5. Without a Postgres Default Database, `DATABASE_URL` selects Postgres when it starts with `postgres://` or `postgresql://`. A libSQL, SQLite, or MySQL `DATABASE_URL` is not used.
6. With none of these configured, it uses `.vitehub/data/openworkflow.sqlite.db` relative to the process working directory.

The local SQLite default requires a writable filesystem. Its state survives only while that file remains available; a replacement container or ephemeral function filesystem can lose it. Configure persistent storage before serving production work. Keep staging and production storage or namespaces separate.

`workflow.database` is unsupported and now rejects configuration. It previously accepted a Named Database without connecting OpenWorkflow to that database. Replace it with `workflow.postgres.url` or `workflow.sqlite.path`, and check the old runtime's actual storage before moving existing runs.

## Run Workflows on Node

With the `node` preset, ViteHub selects OpenWorkflow. You do not configure a provider:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', workflow: true })],
})
```

- `runWorkflow()` puts the run in storage and returns it with the status `queued`. A worker then executes it.
- Each server starts the OpenWorkflow worker when it starts. On `SIGTERM`, the worker stops taking runs. A run that does not finish in the [drain budget](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) keeps its lease for 30 seconds. Then another worker takes it.
- With a Postgres Default Database, OpenWorkflow keeps its runs in that database, in the `openworkflow` schema. Without one, set `OPENWORKFLOW_POSTGRES_URL` or a Postgres `DATABASE_URL`. Without any of them, runs stay in `.vitehub/data/openworkflow.sqlite.db`, on one host only, and the server logs that at boot.
- Several servers can use the same Postgres database. When they start together, one server at a time creates the `openworkflow` schema. A server tries a Postgres advisory lock in a short transaction, and a server that does not get it waits without a connection. The server that gets it uses two connections for a moment: the lock and the OpenWorkflow migration. When a pooler gives the app one connection, the migration cannot start while the lock holds it, so the lock ends after 60 seconds and the migration then runs without it. Set `postgres.runMigrations: false` after the schema exists to skip this wait. OpenWorkflow takes each run with `FOR UPDATE SKIP LOCKED`, so only one worker executes it.
- When the storage is not ready, for example while Postgres starts, the server reports the error and tries again. The delay grows from 0.5 to 30 seconds. The server serves requests meanwhile, and queued runs wait in storage until the worker starts.
- `vite dev` also starts the worker, so runs complete on your computer. It keeps runs in `.vitehub/data/openworkflow.sqlite.db`, even when `.env` sets `DATABASE_URL`, so a dev server never runs the runs of a shared database with local code. Set `workflow: { remote: true }` to use that database in `vite dev`. When you change a Workflow file, the dev server starts a new worker with the new code.

### Which Workflows are durable

Every worker registers the Workflow files that ViteHub discovers, such as `server/workflows/<name>.ts`, when it starts. Any worker can take a run, so only those Workflows go to OpenWorkflow. A Workflow that code creates while the server runs, such as `createWorkflow('name', handler)` or an Agent Workflow, runs inline in the request process instead. It is not durable, its run has `metadata.mode` set to `"inline"`, and the server logs a warning the first time. Move the Workflow to a file in `server/workflows/` to make it durable.

### Run the worker in its own process

Set `worker: false` when a separate process runs the Workflows. The web servers then only put runs in storage.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', workflow: { worker: false } })],
})
```

The [Workflow package README](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker) shows the worker process. Give it the same storage as the servers.
