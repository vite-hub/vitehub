---
title: Workflows hosts
description: "Choose a Workflow Provider and storage per host: Cloudflare Workflows, Vercel, or OpenWorkflow with Postgres or SQLite."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Host | Provider without `provider` |
| --- | --- |
| Cloudflare | Cloudflare |
| Vercel | Vercel |
| Netlify | None. Set `provider`. |
| Node, Docker, Deno, and other hosts | OpenWorkflow when you set `postgres.url` or `sqlite.path`. Else the build fails with `WORKFLOW_C0020`. |
| `vite dev` on a host without a provider | Inline runs in the dev server |

ViteHub infers Vercel only on Vercel. The Workflow that only `agent` turns on runs inline on Node, Docker, and Deno, and a restart loses its runs. `vitehub durability list` shows the store that the app uses.


| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { provider: 'cloudflare' }` | Workflow class, binding, and runtime entry. | Runs through Cloudflare Workflow bindings. Set `binding` and `name` to match existing resources. Without the binding, only `vite dev` runs the Workflow inline. A deployed Worker fails with `WORKFLOW_R0036`. |
| Vercel | `workflow: { provider: 'vercel' }` | Workflow runtime in the build output, on Vercel only. Other hosts get none. | A `native` entry uses Workflow DevKit for durable execution. The normal handler runs inline and stops if the function restarts. |
| OpenWorkflow | `workflow: { provider: 'openworkflow', postgres: { url } }` or `workflow: { provider: 'openworkflow', sqlite: { path } }` | OpenWorkflow worker and runtime. | Choose Postgres or SQLite for deployment. Set `postgres.url` or `sqlite.path`, not both. |

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
3. Else `OPENWORKFLOW_POSTGRES_URL`, then `DATABASE_URL`, selects Postgres.
4. Else it uses `.vitehub/data/openworkflow.sqlite.db` in the process working directory.

> [!WARNING]
> The SQLite default needs a writable filesystem. Its state lives only as long as that file. A new container or a temporary function filesystem can lose it. Set up persistent storage before production. Keep staging and production storage or namespaces apart.

`workflow.database` is not supported and fails the config. It used to accept a Named Database without connecting OpenWorkflow to it. Use `workflow.postgres.url` or `workflow.sqlite.path` instead. Check where the old runtime really stored runs before you move them.
