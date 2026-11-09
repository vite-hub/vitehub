---
title: Comments hosts
description: Check what Comments supports on Node, Cloudflare, Vercel, and Netlify, with comments() or in a ViteHub app, and run it behind a proxy that ends TLS.
navigation.title: Hosts
navigation.order: 7
icon: i-lucide-cloud-cog
---

The [`comments()` plugin](/docs/comments/get-started) keeps threads in the database you point it to: a SQLite file on a lasting disk, a Turso database, or Cloudflare D1. A [ViteHub app](/docs/comments/with-vite-hub) uses a Database, which every host below supports.

## With `comments()`

| Host | Works | Where threads go |
| --- | --- | --- |
| `vite dev` | Yes | `.vitehub/data/comments.sqlite`, no option needed |
| `vite dev` with a Cloudflare host | Yes | A local D1 binding `COMMENTS` in `.wrangler/state`, no option needed |
| Node, Docker (one process) | Yes | `comments({ database: 'file:./data/comments.sqlite' })` on a disk or volume that survives deploys |
| Several processes or machines | Yes | A Turso database: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on each server. |
| Cloudflare Workers | Yes | `comments({ database: 'd1:COMMENTS' })`, or a D1 binding named `DB`. See [Cloudflare D1](/docs/comments/configure#cloudflare-d1). |
| Vercel, Netlify | Yes | A Turso database, set in the project's environment variables. |

`comments()` runs on the [Nitro](https://nitro.build) server, which builds for the host it detects. Set `NITRO_PRESET=cloudflare_module` to build for Workers. The SQLite file needs Node.js 22.5 or newer for `node:sqlite`. It has no presence, edits in place, or Console section.

[Sign in with GitHub](/docs/comments/configure#sign-in-with-github) stores nothing on the server, because the session is a cookie. It works the same in a ViteHub app on every host.

## In a ViteHub app

Presence and cursors also need a [Realtime room authority](/docs/realtime/configure#choose-a-room-authority). Without one, everything else works.

### Host support

| Host | Threads, replies, resolve | Edits in place | Presence and cursors |
| --- | --- | --- | --- |
| `vite dev` | Yes | Yes, with Content | Yes, with Realtime on. Rooms run in the dev server. |
| Node, Docker (one process) | Yes | Yes, with Content | Yes, with `realtime: { authority: 'memory' }` |
| Cloudflare Workers | Yes, with D1 | Yes, with Content | Yes, with Durable Objects |
| Vercel, Netlify | Yes | Yes, with Content | No. Pages reload threads on focus and every 30 seconds. |

The overlay works in Nitro 3 apps, including Nuxt 5, on each of these hosts.

### Node

Use a SQLite file or libSQL Database, and the memory room authority:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    database: true,
    realtime: { authority: 'memory' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      database: true,
      realtime: { authority: 'memory' },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      database: true,
      realtime: { authority: 'memory' },
    }),
  ],
})
```
:::
::

The memory authority keeps presence rooms in one process. With several processes or machines, people see only others on their process. Comments still reach everyone when the processes share a libSQL Database, but a local SQLite file is not shared between machines.

### Cloudflare

Use a D1 Database. On the Cloudflare host, `realtime: true` selects Durable Objects, with one room per page.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    database: { driver: 'd1', databaseName: 'site' },
    realtime: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      database: { driver: 'd1', databaseName: 'site' },
      realtime: true,
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      database: { driver: 'd1', databaseName: 'site' },
      realtime: true,
    }),
  ],
})
```
:::
::

Run `pnpm vitehub provision run --provider cloudflare` to create the D1 Database, then apply the migrations. See [Database hosts](/docs/database/hosts) and [Realtime host support](/docs/realtime/configure#host-support).

### Vercel and Netlify

Use a hosted Database, such as libSQL. Do not turn on Realtime. These hosts have no room authority, so the build fails with `REALTIME_MISSING_AUTHORITY`. Comments runs without avatars or cursors. Each page reloads its threads on tab focus and every 30 seconds while visible.

## Proxies that end TLS

Behind a proxy that ends TLS, such as nginx, the server gets `http://` requests on an internal host. The Comments API compares the `Origin` of each `POST` and `DELETE` with the origin the browser sees. It reads that origin from the first value of `X-Forwarded-Proto` and `X-Forwarded-Host`.

::warning
Set both headers on the proxy, or every write fails with `403` and [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden).
::

```nginx [nginx.conf]
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  # WebSockets of the presence rooms
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

Presence rooms connect through Realtime, which checks the WebSocket origin itself. See [Realtime identity and authorization](/docs/realtime/server-api#identity-and-authorization).

## Caching

Pages with the page tools loader get `cache-control: private, no-store`. Other pages keep your app's headers, and their bootstrap is the same for every visitor, so a CDN can cache them by URL. With the `vitehub-tools` cookie, the cached page loads the loader itself.

## Content Security Policy

The page gets one same-origin script: the page tools loader at `/_vitehub/page/assets/loader.js`. It imports the overlay from `/api/_vitehub/comments/assets/overlay.js`. With a base path such as Vite `base: '/docs/'`, both paths start with `/docs`.

- When the `Content-Security-Policy` header has a script nonce, as with `'strict-dynamic'` in nuxt-security, the loader script gets that nonce. `'strict-dynamic'` then trusts the overlay it imports.
- The overlay adds styles inside its shadow root, so `style-src` must allow inline styles.
- Presence uses a same-origin WebSocket, so `connect-src`, when set, needs `'self'`.

## Inspect the build

`vitehub inspect` lists the Comments route `/api/_vitehub/comments/**`, the presence state, and the page tool hint. Without a Realtime authority, the presence line reads `off: the host has no Realtime authority`. The Database inspector lists the two Comments tables as contributed tables.
