---
title: Guard your first request
description: Allow two requests per minute and check that the third returns HTTP 429.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You add a limit to one API route: two requests per minute. Then you send three requests and see the third one fail with HTTP `429 Too Many Requests`.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.

You do not need a cloud account.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

`vite-hub` gives you Rate Limit. `nitro` and `h3` serve the API route. `vite` runs the dev server.

Add the `vitehub` plugin to `vite.config.ts`. Keep the other plugins that your config already has.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', rateLimit: true })],
})
```

- `preset: 'node'` builds the app for a plain Node.js server. A preset is the host that ViteHub builds for. For other hosts, see [Hosts](/docs/rate-limit/hosts).
- `rateLimit: true` turns on Rate Limit.

> [!NOTE]
> The `node` preset counts requests in this process's memory. Counts reset on restart and are not shared with other app instances. For a count that all instances share, see [Hosts](/docs/rate-limit/hosts).

::

::tutorial-step{title="Protect one route"}
## Protect one route

Create `server/api/image-upload.post.ts`. Call `requireRateLimit()` at the top of the route, before the route does any work. A request over the limit then stops there and never reaches the upload. The guard does not need a dedicated directory, file suffix, or module-scope declaration. You call it in a normal route.

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
- `limit: 2` and `window: '1m'` allow two requests from each client in one minute.

On the `node` preset, each minute starts at second 0 of the clock, not at your first request. [Rate limiting algorithms](/docs/guides/rate-limiting-algorithms) shows what this means at the edge of a minute.

::

::tutorial-step{title="Send three requests"}
## Send three requests

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and send three requests in less than one minute. `-i` shows the HTTP status and headers.

```bash [commands/request]
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
```

The first two responses are `200` with `{ "ok": true, "message": "accepted" }`. The third response is `429`. This proves that the limit stops the third request before the route does its work.

By default, `requireRateLimit()` counts requests by the client address. When a request is over the limit, it throws a standard H3 `HTTPError`. To count by user or account, pass `key: authenticatedUser.id`.

::

::tutorial-step{title="Inspect the limit"}
## Inspect the limit

Build the app and print the limits that ViteHub found:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind rate-limit
```

Use this list to check your limits before you choose a host.

::

## Next steps

- [Hosts](/docs/rate-limit/hosts): deploy to Cloudflare and share one count across all app instances.
- [Limits and errors](/docs/rate-limit/limits-and-errors): check what each host can and cannot do before production.
