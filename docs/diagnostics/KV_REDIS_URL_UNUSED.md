---
description: "Fix KV_REDIS_URL_UNUSED by selecting the Redis driver explicitly, or configure KV to keep using its current store."
---

KV does not select the Redis driver just because `REDIS_URL` is set or `KV_URL` contains a `rediss://` URL.

To use `REDIS_URL`, set the driver explicitly:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ kv: { driver: 'redis' } })],
})
```

To use `KV_URL`, set the driver and point it at that variable:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ kv: { driver: 'redis', url: 'env:KV_URL' } })],
})
```

If KV should keep using its current store instead, set that store's driver explicitly.
