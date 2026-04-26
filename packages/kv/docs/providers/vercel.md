---
title: Vercel KV
description: Configure @vitehub/kv for Vercel using the Upstash-backed driver.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro, nuxt]
---

Use the Vercel provider path when runtime KV should read and write through Upstash REST credentials.

Vercel needs the `upstash` driver and runtime environment variables. ViteHub masks build-time Upstash credentials in generated config and resolves the real values when the first KV operation runs.

::steps{level="2"}

## Configure KV

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `kv.driver` to `upstash`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'upstash',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and set `kv.driver` to `upstash`:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
  kv: {
    driver: 'upstash',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
Register the Nuxt module and set `kv.driver` to `upstash`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'upstash',
  },
})
```
::

## Add Runtime Environment Variables

Set the preferred Upstash REST variables:

```bash
KV_REST_API_URL=https://example.upstash.io
KV_REST_API_TOKEN=<upstash-rest-token>
```

ViteHub also accepts the Upstash Redis REST aliases:

```bash
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
```

## Let Hosting Select Upstash

When hosting resolves to Vercel and no explicit driver is set, ViteHub selects `upstash` automatically:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
})
```

This still requires runtime credentials. If they are missing, the first KV access throws:

```txt
Missing runtime environment variable `KV_REST_API_URL` for Upstash KV.
```

## Avoid `fs-lite` on Vercel

`fs-lite` is a local development driver. If Vercel hosting is detected while `fs-lite` is configured, the Nitro module logs:

```txt
Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
```

Change the driver to `upstash` or remove explicit local config before deploying.

## Inline Credentials

You can pass credentials in config:

```ts
kv: {
  driver: 'upstash',
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
}
```

Environment variables are preferred for hosted deployments. They keep secrets in runtime configuration instead of source-controlled config files.

## Verify the Provider

Write a value:

```bash
curl -X PUT https://<your-project>.vercel.app/api/settings
```

Read it back:

```bash
curl https://<your-project>.vercel.app/api/settings
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

## Common Failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing runtime environment variable \`KV_REST_API_URL\`` | Upstash URL is missing at runtime. | Set `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`. |
| `Missing runtime environment variable \`KV_REST_API_TOKEN\`` | Upstash token is missing at runtime. | Set `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN`. |
| Vercel logs warn about `fs-lite` | Explicit local driver was deployed. | Set `kv.driver` to `upstash` or rely on Vercel hosting inference. |

## Related Pages

- [Quickstart](../quickstart)
- [Choose a driver](../guides/choose-a-driver)
- [Runtime API](../runtime-api)
- [Troubleshooting](../troubleshooting)
