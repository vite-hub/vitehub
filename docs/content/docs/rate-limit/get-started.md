---

title: Guard your first request
description: Allow two requests per minute and check that the third returns HTTP 429.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Rate Limit blocks clients that send too many requests. You set how many requests a client may send in a time window. ViteHub counts them and refuses the extra ones.

In this tutorial, you allow two requests per minute on a route and check that the third returns HTTP `429 Too Many Requests`.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need no account or API key. On Node, counts live in process memory by default, so they reset on restart and are not shared across instances. To share them, turn on KV with Redis or Postgres, see [Share counts on Node](/docs/rate-limit/hosts#share-counts-on-node).

::tutorial-step{title="Install and configure"}
## Install and configure

Install the Rate Limit package:

```bash pm [commands/install]
pnpm add @vite-hub/rate-limit
```

Add `rateLimit: true` to your ViteHub options in `nuxt.config.ts` or `vite.config.ts`, keeping your existing plugins.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { rateLimit: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ rateLimit: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ rateLimit: true })],
})
```
::::
:::

To use Rate Limit on another host, see [Hosts](/docs/rate-limit/hosts).

::

::tutorial-step{title="Protect one route"}
## Protect one route

Create `server/api/image-upload.post.ts` and call `requireRateLimit()` at the top of the handler. You do not need a dedicated folder, file suffix, or module-scope declaration.

```ts [server/api/image-upload.post.ts]
import { defineEventHandler } from 'h3'
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  await requireRateLimit(event, 'image-upload', {
    limit: 2,
    window: '1m',
  })
  return { ok: true, message: 'accepted' }
})
```

- `'image-upload'` names this limit.
- `limit: 2` and `window: '1m'` allow two requests per minute per client.
- Call the guard before the real work of the route, such as an upload. Then a refused request does no work.

On Node, each `1m` window starts at second 0 of the clock minute. [Rate limiting algorithms](/docs/guides/rate-limiting-algorithms) shows what that means at the edge of a window.

::

::tutorial-step{title="Run and verify the decision"}
## Run and verify the decision

Start the dev server:

```bash [commands/start]
pnpm dev
```

Leave the server running. Open a second terminal and send three requests within the same minute. Each command prints the HTTP status code:

```bash [commands/request]
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/image-upload
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/image-upload
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/image-upload
```

You get:

```text [output/request.txt]
200
200
429
```

The first two requests return `200` with `{ "ok": true, "message": "accepted" }`. The third returns `429`. If a new clock minute starts between commands, the counter resets and all three can succeed. Wait for the next minute and run the three commands again.

When a request exceeds the limit, `requireRateLimit()` throws a standard H3 `HTTPError` and stops the route.

By default, `requireRateLimit()` counts per client IP address. To count per user, account, tenant, or API client, pass an ID as `key`, such as `key: authenticatedUser.id`.

To inspect the limits found at build time, stop the dev server, build the app, and list them:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind rate-limit
```

The output shows your rate limit along with its settings and source location:

```text [output/inspect.txt]
Rate Limits (rate-limit): 1
  image-upload  server/api/image-upload.post.ts  [require-rate-limit]
    Limit: 2
    Window: 1m
    Enforcement: Best effort
    Provider failure: Deny
    Source location: 5:9
```

::

## Next steps

::card-group
:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/rate-limit/hosts"}
Share counters across app instances and see the Cloudflare output.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/rate-limit/limits-and-errors"}
Check what to know before you go to production.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/rate-limit/server-api"}
See every option of `requireRateLimit()`.
:::
::
