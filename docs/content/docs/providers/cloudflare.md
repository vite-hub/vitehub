---
title: Cloudflare
description: Cloudflare support across ViteHub packages.
navigation.title: Cloudflare
navigation.group: Providers
icon: i-logos-cloudflare-icon
---

Use this page to find package-specific Cloudflare guidance in ViteHub.

## Currently documented packages

### KV

`@vite-hub/kv` supports a Cloudflare KV path through `cloudflare-kv-binding`.

- Setup overview: [KV overview](../kv)
- Provider details: [KV on Cloudflare](../kv/providers/cloudflare)

::fw{id="vite:dev vite:build"}
### DB

`@vite-hub/database` supports Cloudflare D1 bindings on Vite through a default database plus optional named databases.

- Setup overview: [Database overview](/docs/vite/database)
- Provider details: [Database on Cloudflare](/docs/vite/database/providers/cloudflare)

### Blob

`@vite-hub/blob` supports a Cloudflare path on Vite and Nitro through the `cloudflare-r2` driver.

- Setup overview: [Blob overview](/docs/vite/blob)
- Provider details: [Blob on Cloudflare](/docs/vite/blob/providers/cloudflare)

### Queue

`@vite-hub/queue` supports a Cloudflare path on Vite and Nitro through `queue.provider = 'cloudflare'`.

- Setup overview: [Queue overview](/docs/vite/queue)
- Provider details: [Queue on Cloudflare](/docs/vite/queue/providers/cloudflare)

### Schedule

`@vite-hub/schedule` supports Cloudflare Provider Output on Vite and Nitro when the Vite Integration or Nitro Integration discovers Static Schedule Definitions.

- Setup overview: [Schedule overview](/docs/vite/schedule)
- Provider details: ViteHub writes worker cron triggers to `wrangler.json`; Cloudflare scheduled events wake the deployed worker and run matching Schedule Definitions.
::

::fw{id="nitro:dev nitro:build"}
### Blob

`@vite-hub/blob` supports a Cloudflare path on Vite and Nitro through the `cloudflare-r2` driver.

- Setup overview: [Blob overview](/docs/nitro/blob)
- Provider details: [Blob on Cloudflare](/docs/nitro/blob/providers/cloudflare)

### Queue

`@vite-hub/queue` supports a Cloudflare path on Vite and Nitro through `queue.provider = 'cloudflare'`.

- Setup overview: [Queue overview](/docs/nitro/queue)
- Provider details: [Queue on Cloudflare](/docs/nitro/queue/providers/cloudflare)

### Schedule

`@vite-hub/schedule` supports Cloudflare Provider Output on Vite and Nitro when the Vite Integration or Nitro Integration discovers Static Schedule Definitions.

- Setup overview: [Schedule overview](/docs/nitro/schedule)
- Provider details: ViteHub writes worker cron triggers to `wrangler.json`; Cloudflare scheduled events wake the deployed worker and run matching Schedule Definitions.
::

## What stays package-specific

Bindings, namespace IDs, and exact config examples live with the package docs. Use this section as a routing page, not as the source of truth for package setup.

Schedule Runtime Helpers are separate from Provider Output. Creating or changing a Runtime Schedule does not automatically provision Cloudflare cron triggers; worker cron configuration comes from Static Schedule Definitions discovered at build time.
