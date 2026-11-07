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
> You need Node.js 22.22 or newer, pnpm, and a Vite app. Run the commands from the root of the app. You need no account and no API key. The Node preset counts requests in this process's memory. Counts reset on restart and are not shared with other app instances. See [Hosts](/docs/rate-limit/hosts) for a shared count.

::tutorial-step{title="Install and configure"}
## Install and configure

Install ViteHub. Nitro is the server that runs your API routes.

```bash pm [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Add `rateLimit: true` to `vitehub()` in `vite.config.ts`. Keep the other plugins of your app.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', rateLimit: true })],
})
```

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

On the Node preset, each window starts at second 0 of each clock minute. [Rate limiting algorithms](/docs/guides/rate-limiting-algorithms) shows what that means at the edge of a window.

::

::tutorial-step{title="Run and verify the decision"}
## Run and verify the decision

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal. Send three requests in less than one minute. `-i` shows the HTTP status of each response.

```bash [commands/request]
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
```

The first two responses are `200` with `{ "ok": true, "message": "accepted" }`. The third response is `429`.

When a request is over the limit, `requireRateLimit()` throws a standard H3 `HTTPError`. The route stops there.

By default, `requireRateLimit()` counts per client IP address. To count per user, account, tenant, or API client, pass that id as `key`, for example `key: authenticatedUser.id`.

To see the limits that the build found, build the app and list them:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind rate-limit
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
