---
title: Cloudflare D1
description: Configure Cloudflare D1 metadata in a database definition.
navigation.title: Cloudflare
navigation.order: 4
icon: i-lucide-cloud
frameworks: [vite]
---

Cloudflare D1 binding metadata lives with the database definition.

```ts [server/databases/analytics/config.ts]
export default defineDatabase({
  cloudflare: {
    binding: 'DB_ANALYTICS',
    databaseName: 'analytics',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    previewDatabaseId: process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID,
  },
  tables: { analyticsEvents },
})
```

Hosted Cloudflare output uses the active D1 binding first. If no D1 metadata is present, the database must have a remote libSQL fallback URL.

Generated Wrangler output includes `d1_databases` entries for definitions with `cloudflare.databaseId`.
