---

title: Guard your first request
description: Allow two requests per minute and check that the third returns HTTP 429.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Allow two requests in one minute, then reject the third with HTTP `429`. Add the guard before the work in your route so requests over the limit cannot reach that work.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The Node preset counts requests in this process's memory. Counts reset on restart and are not shared with other app instances. See [Hosts](/docs/rate-limit/hosts) for shared enforcement.

::tutorial-step{title="Install and configure"}
## Install and configure

Install ViteHub and Nitro. Add the plugins below to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Enable Rate Limit on the `node` preset for this local check. Supported deployment presets and provider configuration are in [Hosts](/docs/rate-limit/hosts).

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', rateLimit: true }), nitro() as never],
})
```

::

::tutorial-step{title="Protect one route"}
## Protect one route

Require the Rate Limit directly in ordinary server code. The guard does not need a dedicated directory, file suffix, or module-scope declaration.

The name `image-upload` identifies this policy. `limit: 2` permits two requests per client in a one-minute window. Put the guard before any upload or other side effect.

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

::

::tutorial-step{title="Run and verify the decision"}
## Run and verify the decision

Start the dev server and call the route three times from the same client:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

Run these requests within one minute. `-i` includes the HTTP status and headers so you can see the third request change to `429`.

```bash [commands/request]
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
```

The first two responses are `200` with `{ "ok": true, "message": "accepted" }`.
The third response is `429`. `requireRateLimit()` uses the event's client
address by default and throws a standard H3 `HTTPError` when the request is
limited. Pass `key: authenticatedUser.id` when a user, account, tenant, or API
client is the correct budget boundary.

Inspect the generated policy before choosing a hosted provider:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind rate-limit
```

Continue with [Hosts](/docs/rate-limit/hosts) for Cloudflare output and
[limits and errors](/docs/rate-limit/limits-and-errors) for production checks.
::
