---
title: KV quickstart
description: Register KV, write a settings value, read it back, and verify the JSON response.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro, nuxt]
---

This guide creates one `settings` key. The write route stores a JSON value and the read route returns it through the same `kv` handle.

The examples use the local `fs-lite` driver so you can verify the app before choosing Cloudflare or Vercel.

::code-collapse

```txt [Prompt]
Set up @vitehub/kv in this app.

- Install @vitehub/kv
- Register hubKv(), @vitehub/kv/nitro, or @vitehub/kv/nuxt
- Configure kv.driver as fs-lite for local development
- Add routes that call kv.set('settings', value) and kv.get('settings')
- Return the stored value as JSON

Docs: /docs/vite/kv/quickstart, /docs/nitro/kv/quickstart, or /docs/nuxt/kv/quickstart
```

::

::steps

### Install KV

```bash
pnpm add @vitehub/kv
```

### Register the integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the local driver:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'fs-lite',
    base: '.data/kv',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the local driver:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
  kv: {
    driver: 'fs-lite',
    base: '.data/kv',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
Register the Nuxt module and choose the local driver:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'fs-lite',
    base: '.data/kv',
  },
})
```
::

### Write a value

::fw{id="vite:dev vite:build"}
Use the `kv` handle from server code that runs with the Nitro storage mount:

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

serve(app)
```
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
Add a route that writes the value:

```ts [server/api/settings.put.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  await kv.set('settings', { enabled: true })
  return { ok: true }
})
```
::

### Read the value

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
Add a route that reads it back:

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```
::

### Verify the response

Write the value:

```bash
curl -X PUT http://localhost:3000/api/settings
```

Read it back:

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

::

## Hosted Providers

The route code stays the same when you switch providers. Change config and deployment environment only:

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure the Cloudflare KV binding driver.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure the Upstash-backed Vercel path.
  to: ./providers/vercel
  ---
  :::
::

## Next Steps

- Use [Usage](./usage) for key naming, prefixes, and common methods.
- Use [Runtime API](./runtime-api) for exact config shapes.
- Use [Troubleshooting](./troubleshooting) if the runtime mount or provider credentials are missing.
