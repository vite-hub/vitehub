---
title: ViteHub vs NuxtHub
description: Compare ViteHub and NuxtHub for Nuxt server services, databases, deployment targets, Agent support, and migration work.
navigation.title: NuxtHub
navigation.order: 7
navigation.group: Server frameworks
icon: i-simple-icons-nuxt
---

Choose NuxtHub when you want its SQL, Blob, KV, and cache integration in a Nuxt
application. Evaluate ViteHub when you also need Agent Definitions or other
server services, or want to use the same APIs in a Vite application.

NuxtHub v0.10 supports multiple clouds and self-hosting. It is not limited to
Cloudflare. Compare the current module rather than its retired hosting service.

## Compare the scope

| Decision | NuxtHub | ViteHub |
| --- | --- | --- |
| Application framework | Nuxt module. | Vite integration and a Nuxt module. |
| Core server services | SQL database, Blob, KV, and cache. | Database, Blob, KV, and additional services such as Queue, Workflow, and Schedule. |
| Database | Drizzle with documented PostgreSQL, MySQL, and SQLite providers. | Drizzle with SQLite, libSQL, D1, and Postgres support. Check the selected driver. |
| Agent application | Compose NuxtHub services with the Agent library you choose. | Agent Definitions, Drivers, Capabilities, and Workspaces in the same project. |
| Deployment | Multi-cloud provider selection. | Host preset plus per-service providers and limits. |

Keep NuxtHub if its services already fit the app and there is no concrete
reason to replace them. An Agent library can use existing application routes
and services without a storage migration.

## Check Nuxt compatibility first

ViteHub's Nuxt integration targets the Nitro v3 integration described in its
[Nuxt setup](/docs/frameworks-hosts/nuxt). Nitro v3 is still beta at the time of
this comparison. Confirm that your Nuxt release includes the required Nitro
integration. Do not infer compatibility with current stable Nuxt from this page.

For an application that cannot adopt that server integration yet, keep the
working module until the target versions are available and verified.

## Plan migration by service

KV and Blob calls need import and error-handling changes. Database migration
also needs schema, dialect, resource identity, and migration-history checks.
Neither module moves existing data because you replace its configuration.

Read [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub) for the
KV, Blob, and SQLite-family migration path. That guide does not describe a
Postgres or MySQL migration. Test the required ViteHub driver separately.

Sources checked on 29 October 2026:
[NuxtHub v0.10 migration](https://hub.nuxt.com/docs/getting-started/migration),
[NuxtHub database](https://hub.nuxt.com/docs/database), and
[ViteHub Database](https://github.com/vite-hub/vitehub/tree/main/packages/database).
Use the [support matrix](/docs/frameworks-hosts/support-matrix) for host proof.
