---
title: Write and read values
description: Build KV routes that write, read, delete, and return visible JSON responses.
navigation.title: Write and read values
navigation.group: Guides
navigation.order: 30
icon: i-lucide-pencil-line
frameworks: [vite, nitro, nuxt]
---

This guide focuses on the route-side calls. It assumes KV is already registered.

## Call Pattern

Every route follows the same shape:

1. Import `kv` from `@vitehub/kv`.
2. Use a stable string key.
3. Await the KV method.
4. Return an application response.

::fw{id="vite:dev vite:build"}
```ts [src/main.ts]
import { H3, serve } from 'h3'
import { kv } from '@vitehub/kv'

const app = new H3()
  .put('/api/settings', async () => {
    await kv.set('settings', { enabled: true })
    return { ok: true }
  })
  .get('/api/settings', async () => {
    return { settings: await kv.get('settings') }
  })
  .delete('/api/settings', async () => {
    await kv.del('settings')
    return { ok: true }
  })

serve(app)
```
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
```ts [server/api/settings.put.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  await kv.set('settings', { enabled: true })
  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  return { settings: await kv.get('settings') }
})
```

```ts [server/api/settings.delete.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  await kv.del('settings')
  return { ok: true }
})
```
::

## Return a Default Value

`kv.get()` returns `null` when the key is missing. Normalize that at the route boundary when the client expects a stable shape:

```ts
const settings = await kv.get('settings')

return {
  settings: settings ?? {
    enabled: false,
  },
}
```

## Verify the Routes

Write:

```bash
curl -X PUT http://localhost:3000/api/settings
```

Read:

```bash
curl http://localhost:3000/api/settings
```

Expected response:

```json
{
  "settings": {
    "enabled": true
  }
}
```

Delete:

```bash
curl -X DELETE http://localhost:3000/api/settings
```

Read again:

```json
{
  "settings": null
}
```

## Avoid These Mistakes

| Mistake | Fix |
| --- | --- |
| Building provider-specific clients in every route | Configure `kv.driver` and use the `kv` handle. |
| Treating `null` as an object | Check for `null` or return a default value. |
| Using unscoped keys for feature-owned data | Prefix keys by feature or owner. |

## Related Pages

- [Usage](../usage)
- [Runtime API](../runtime-api)
- [Troubleshooting](../troubleshooting)
