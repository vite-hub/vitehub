---
title: Vercel
description: Use remote libSQL database URLs for Vercel DB output.
navigation.title: Vercel
navigation.order: 5
icon: i-lucide-triangle
frameworks: [vite]
---

Vercel output cannot use Cloudflare D1 bindings. Every database that runs on Vercel needs a remote libSQL URL.

```ts [server/databases/primary/config.ts]
export default defineDatabase({
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_DATABASE_URL,
  },
  tables: { notes },
})
```

If a definition only has D1 metadata and no remote fallback URL, hosted Vercel output fails during build.
