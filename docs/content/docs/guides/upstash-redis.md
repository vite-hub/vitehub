---
title: Use Upstash Redis for ViteHub KV
description: Configure the Upstash REST driver, store a value through ViteHub KV, and verify that reads survive an app restart.
navigation.title: Upstash Redis
navigation.order: 10
navigation.group: Storage
icon: i-lucide-database
---

Use Upstash when the app needs a hosted KV store instead of local files.
ViteHub uses Upstash's REST API. Your server code calls `kv` from `vite-hub/kv`.

Start with [Store your first KV value](/docs/kv/get-started). Keep its settings
routes. Create an Upstash Redis database and obtain its REST URL and token.
Remote reads and writes can incur provider charges.

## Select the REST driver

Replace the tutorial's ViteHub options with this configuration. Keep the
other plugins and features your app uses.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({ preset: 'node', kv: { driver: 'upstash' } })],
})
```

Set both variables in the environment used to build and run the app:

```bash [Terminal]
export UPSTASH_REDIS_REST_URL='https://your-database.upstash.io'
export UPSTASH_REDIS_REST_TOKEN='your-rest-token'
pnpm dev
```

ViteHub also accepts `KV_REST_API_URL` and `KV_REST_API_TOKEN`. That pair takes
precedence. Remove stale values if the app connects to the wrong database.
Use the host's secret store in production. Keep the token out of browser code.

For Vercel, use `preset: 'vercel'` and configure the same credentials in the
project environment. The Vercel preset uses Upstash for KV by default.

## Verify remote persistence

Call the tutorial's routes:

```bash [Terminal]
curl --fail-with-body -X PUT http://localhost:3000/api/settings \
  -H 'content-type: application/json' -d '{"theme":"dark"}'
curl --fail-with-body http://localhost:3000/api/settings
```

Both responses contain `{ "settings": { "theme": "dark" } }`. Stop and restart
the app. Repeat the GET request and inspect the key in your Upstash database.
The value must survive without a local `.vitehub/data/kv` directory.

## Keep Redis-specific work separate

ViteHub KV is a storage API. It does not expose every Redis command. Use the
Upstash SDK directly when you need Redis-specific data structures or commands.
Do not build a distributed lock from separate `kv.get()` and `kv.set()` calls.

Read [KV configuration](/docs/kv/configure) for named stores and
[KV limits](/docs/kv/limits-and-errors) for supported operations.
See [Upstash Redis documentation](https://upstash.com/docs/redis/overall/getstarted)
for database regions, credentials, and service limits.
