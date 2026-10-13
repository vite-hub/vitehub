---
title: Workflows hosts
description: Select a Workflow Provider and its storage for each host.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { provider: 'cloudflare' }` | Cloudflare Workflow class, binding, and runtime entry output. | Runs through Cloudflare Workflow bindings. Use `binding` and `name` when the generated names must match existing infrastructure. |
| Vercel | `workflow: { provider: 'vercel' }` | Vercel workflow runtime output under the build output. | A `native` entry uses Workflow DevKit for durable execution. The normal handler runs inline and does not survive a function restart. |
| OpenWorkflow | `workflow: { provider: 'openworkflow', postgres: { url } }` or `workflow: { provider: 'openworkflow', sqlite: { path } }` | OpenWorkflow worker/runtime output. | Choose Postgres or SQLite explicitly for deployment. Configured `postgres.url` and `sqlite.path` are mutually exclusive. |

### Select OpenWorkflow storage

OpenWorkflow resolves storage at runtime in this order:

1. An explicit `sqlite.path` selects SQLite; an explicit `postgres.url` selects Postgres. Configure only one. If its runtime environment declaration is missing or empty, startup fails instead of selecting another store.
2. With neither option configured, `OPENWORKFLOW_SQLITE_PATH` selects SQLite.
3. Otherwise, `OPENWORKFLOW_POSTGRES_URL`, then `DATABASE_URL`, selects Postgres.
4. With none of these configured, it uses `.vitehub/data/openworkflow.sqlite.db` relative to the process working directory.

The local SQLite default requires a writable filesystem. Its state survives only while that file remains available; a replacement container or ephemeral function filesystem can lose it. Configure persistent storage before serving production work. Keep staging and production storage or namespaces separate.

`workflow.database` is unsupported and now rejects configuration. It previously accepted a Named Database without connecting OpenWorkflow to that database. Replace it with `workflow.postgres.url` or `workflow.sqlite.path`, and check the old runtime's actual storage before moving existing runs.
