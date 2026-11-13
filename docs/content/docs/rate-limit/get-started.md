---

title: Guard your first request
description: Allow two requests per minute and check that the third returns HTTP 429.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Rate Limit stops a client that sends too many requests. You set how many requests a client may send in a time window. ViteHub counts them and refuses the extra ones.

In this tutorial, you let a route accept two requests per minute. The third request gets the HTTP status `429 Too Many Requests`.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run every command from the app root. You need no account and no API key. The Node host counts requests in this process's memory. Counts reset on restart and are not shared with other app instances. See [Hosts](/docs/rate-limit/hosts) for a shared count.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the Rate Limit package:

```bash pm [commands/install]
pnpm add @vite-hub/rate-limit
```

Add `rateLimit: true` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep the other plugins of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', rateLimit: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ host: 'node', rateLimit: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ host: 'node', rateLimit: true })],
})
```
::::
:::

To use Rate Limit on another host, see [Hosts](/docs/rate-limit/hosts).

::

::tutorial-step{title="Protect one route"}
## Protect one route

Create `server/api/image-upload.post.ts`. Call `requireRateLimit()` at the start of the route. The guard does not need a dedicated directory, file suffix, or module-scope declaration.

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

- `'image-upload'` is the name of this limit.
- `limit: 2` and `window: '1m'` let each client send two requests per minute.
- Put the guard before the real work of the route, such as an upload. Then a refused request does no work.

On the Node host, each window starts at second 0 of each clock minute. [Rate limiting algorithms](/docs/guides/rate-limiting-algorithms) shows what that means at the edge of a window.

::

::tutorial-step{title="Run and verify the decision"}
## Run and verify the decision

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal. Send three requests in less than one minute. Each command prints the HTTP status of its response.

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

The first two responses are `200` with `{ "ok": true, "message": "accepted" }`. The third response is `429`. If a new clock minute starts between two requests, the count starts again, and the last requests can use the limit of the new minute. In that case, wait for the next clock minute. Then send the three requests again.

When a request is over the limit, `requireRateLimit()` throws a standard H3 `HTTPError`. The route stops there.

By default, `requireRateLimit()` counts per client IP address. To count per user, account, tenant, or API client, pass that id as `key`, for example `key: authenticatedUser.id`.

To see the limits that the build found, stop the dev server. Then build the app and list them:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind rate-limit
```

The list shows your limit and where it is:

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
Share one count across app instances, and see the Cloudflare output.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/rate-limit/limits-and-errors"}
Check what to know before you go to production.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/rate-limit/server-api"}
See every option of `requireRateLimit()`.
:::
::
