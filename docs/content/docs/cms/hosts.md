---
title: CMS hosts
description: Check where each store of the cms preset runs, and provision its Database and Blob resources before a hosted deploy.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

The `cms` preset works wherever [Blob](/docs/blob/hosts) and [Database](/docs/database/hosts) both work: Node with libSQL or a local SQLite file, Cloudflare with D1 and R2, and Vercel. The Workspace reads files from the Blob store and refs from the Database, so every instance sees the same drafts and published documents.

The [GitHub store](/docs/cms/configure#github-store) needs only network access to GitHub and a Database for editor sessions. Set `VITEHUB_GITHUB_TOKEN` on every instance.

## Host support

| Host | Blob + Database store | GitHub store |
| --- | --- | --- |
| Node, Docker | A Database that every instance reaches, such as libSQL, and a Blob store. A local SQLite file works for one process on a persistent disk. | Yes, with a Database for sessions |
| Cloudflare | D1 and R2 | Yes, with D1 for sessions |
| Vercel | A hosted Database and Vercel Blob | Yes, with a hosted Database for sessions |

## Provision resources

Before a hosted deploy, run [Provisioning](/docs/development/provisioning) for your host:

```bash [commands/provision]
pnpm vitehub provision run --provider cloudflare
pnpm vitehub provision run --provider vercel
```

Provisioning creates the same Database and Blob resources as without the preset. The preset adds no resources of its own.

- **Cloudflare.** An R2 bucket, plus a D1 database once you name one, for example with `vitehub({ database: { driver: 'd1', databaseName: 'content' } })`.
- **Vercel.** A Blob store. See [Select a hosted database for Vercel](/docs/database/hosts#select-a-hosted-database-for-vercel).

The hosted Database needs the preset's tables before the first save. Apply the migrations from `vitehub database generate` when you deploy, as [Database hosts](/docs/database/hosts) shows for each provider.

To set the Database connection URL or D1 options yourself, [take over the Database](/docs/cms/configure#take-over-the-database).
