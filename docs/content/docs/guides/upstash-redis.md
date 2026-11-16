---
title: Use Upstash Redis for ViteHub KV
description: Configure the Upstash REST driver, store a value through ViteHub KV, and verify that reads survive an app restart.
navigation.title: Upstash Redis
navigation.order: 10
navigation.group: Storage
icon: i-lucide-database
---

Use Upstash for a hosted KV store instead of local files. ViteHub talks to
Upstash's REST API, and your code calls `kv` from `vite-hub/kv`.

First, complete [Store your first KV value](/docs/kv/get-started) and keep its
settings routes. Create an Upstash Redis database and copy its REST URL and
token. Reads and writes can cost money.

## Select the REST driver

Install the Upstash client:

```bash [Terminal]
pnpm add @upstash/redis
```

Replace the tutorial's ViteHub options with this. Keep your other plugins and
features.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', kv: { driver: 'upstash' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({ host: 'node', kv: { driver: 'upstash' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({ host: 'node', kv: { driver: 'upstash' } })],
})
```
:::
::

Set both variables where you build and run the app:

```bash [Terminal]
export UPSTASH_REDIS_REST_URL='https://your-database.upstash.io'
export UPSTASH_REDIS_REST_TOKEN='your-rest-token'
pnpm dev
```

ViteHub also reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, and that pair
wins. If the app connects to the wrong database, remove old values. In
production, use the host's secret store. Keep the token out of browser code.

For Vercel, use `host: 'vercel'` and set the same credentials in the project.
That host uses Upstash for KV by default.

## Verify remote persistence

```bash [Terminal]
curl --fail-with-body -X PUT http://localhost:3000/api/settings \
  -H 'content-type: application/json' -d '{"theme":"dark"}'
curl --fail-with-body http://localhost:3000/api/settings
```

Both responses contain `{ "settings": { "theme": "dark" } }`. Restart the app,
repeat the GET, and find the key in Upstash. The value must survive without a
local `.vitehub/data/kv` directory.

## Keep Redis-specific work separate

ViteHub KV is a storage API, not every Redis command. For Redis data
structures or commands, use the Upstash SDK. Do not build a distributed lock
from separate `kv.get()` and `kv.set()` calls.

See [KV configuration](/docs/kv/configure) for named stores,
[KV limits](/docs/kv/limits-and-errors) for supported operations, and the
[Upstash Redis docs](https://upstash.com/docs/redis/overall/getstarted) for
regions, credentials, and limits.
