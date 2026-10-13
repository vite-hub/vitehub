---

title: Store your first KV value
description: Write a theme setting to local KV and read the same key back.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Save a theme setting under the key `settings`, then read it back in the same request. KV suits settings, feature flags, and other small JSON values that you access by key. This example returns `{ "settings": { "theme": "system" } }`.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The default local driver stores values under `.vitehub/data/kv` and needs no account. Choose a [hosted driver](/docs/kv/hosts) before sharing the store across app instances.

::tutorial-step{title="Install and configure"}
## Install and configure

Install KV and Nitro. Add the plugins below to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add @vite-hub/kv nitro h3
pnpm add -D vite
```

Register KV in `vite.config.ts`:

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubKv(), nitro() as never],
})
```

::

::tutorial-step{title="Write and read one key"}
## Write and read one key

The key is always `settings`. A later request replaces its value rather than creating a new record. The route checks each operation's error before using the read result.

```ts [server/api/settings.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const settings = await readBody<{ theme: string }>(event)
  const [writeError] = await kv.set('settings', settings)
  if (writeError) throw writeError

  const [readError, storedSettings] = await kv.get<{ theme: string }>('settings')
  if (readError) throw readError
  return { settings: storedSettings }
})
```

`kv.set()` and `kv.get()` return `[error, value]` tuples. Check the first slot
before using a value.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start Vite and send one request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X PUT http://localhost:5173/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

The route returns the value read from KV:

```json [output/response.json]
{ "settings": { "theme": "system" } }
```

The route read the same value it wrote. Try changing the request body to `{"theme":"dark"}`; the response should return `dark` because both requests use the same key.

The `fs-lite` driver stores values under `.vitehub/data/kv`. This route writes before it reads, so calling it after a restart alone does not prove persistence. Use a separate read with the [Server API](/docs/kv/server-api) to check a stored value, or continue with [Configuration](/docs/kv/configure) for named stores.
::
