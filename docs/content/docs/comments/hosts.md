---
title: Comments hosts
description: Check what Comments supports on Node, Cloudflare, Vercel, and Netlify, and run it behind a proxy that ends TLS.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

Comments needs a Database on every host. Presence and cursors also need a [Realtime room authority](/docs/realtime/configure#choose-a-room-authority). Without one, threads, replies, resolve, and edits in place still work.

## Host support

| Host | Threads, replies, resolve | Edits in place | Presence and cursors |
| --- | --- | --- | --- |
| `vite dev` | Yes | Yes, with Content | Yes, when Realtime is on. Rooms run in the dev server. |
| Node, Docker (one process) | Yes | Yes, with Content | Yes, with `realtime: { authority: 'memory' }` |
| Cloudflare Workers | Yes, with D1 | Yes, with Content | Yes, with Durable Objects |
| Vercel, Netlify | Yes | Yes, with Content | No. Pages read threads again on focus and every 30 seconds. |

The overlay works in Nitro 3 apps and in Nuxt 4 apps on each of these hosts.

## Node

Use a SQLite file or libSQL Database, and the memory room authority:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      database: true,
      realtime: { authority: 'memory' },
    }),
  ],
})
```

The memory authority keeps the presence rooms in one process. With several processes or machines, people see only the people on the same process. Their comments still reach each other when the processes share a libSQL Database. A local SQLite file is not shared between machines.

## Cloudflare

Use a D1 Database. `realtime: true` selects Durable Objects on the Cloudflare preset, and each page gets its own room.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      database: { driver: 'd1', databaseName: 'site' },
      realtime: true,
    }),
  ],
})
```

Run `pnpm vitehub provision run --provider cloudflare` to create the D1 Database, then apply the migrations. See [Database hosts](/docs/database/hosts) and [Realtime host support](/docs/realtime/configure#host-support).

## Vercel and Netlify

Use a hosted Database, such as libSQL. Do not turn on Realtime: these hosts have no room authority, and the build fails with `REALTIME_MISSING_AUTHORITY`. Comments then runs without presence. The toolbar shows no avatars or cursors, and each page reads its threads again when the tab gets focus and every 30 seconds while it is visible.

## Proxies that end TLS

When nginx or another proxy ends TLS, the server gets `http://` requests on an internal host. The Comments API compares the `Origin` of each `POST` and `DELETE` with the origin that the browser sees. It reads that origin from the first value of `X-Forwarded-Proto` and `X-Forwarded-Host`. Set both on the proxy, or every write fails with `403` and [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden).

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

The presence rooms connect through Realtime, which checks the WebSocket origin itself. See [Realtime identity and authorization](/docs/realtime/server-api#identity-and-authorization).

## Caching

Pages with the page tools loader go out with `cache-control: private, no-store`. Other pages keep the headers your app sets. A CDN that caches HTML by URL can serve a cached page to a browser with the `vitehub-tools` cookie, and that page has no loader. Bypass the cache for requests with the cookie, or open pages with `?vitehub`.

## Content Security Policy

The page gets one script from the same origin, the page tools loader at `/_vitehub/page/assets/loader.js`. The loader imports the overlay from `/api/_vitehub/comments/assets/overlay.js`. With a base path, such as Vite `base: '/docs/'`, both paths start with `/docs`. When the page's `Content-Security-Policy` header has a script nonce, as with `'strict-dynamic'` in nuxt-security, the server gives the loader script that nonce, and `'strict-dynamic'` trusts the overlay that it imports. The overlay adds its styles inside its shadow root, so `style-src` must allow inline styles. Presence uses a WebSocket to the same origin, so `connect-src`, when you set it, needs `'self'`.

## Inspect the build

`vitehub inspect` lists the Comments route `/api/_vitehub/comments/**`, the presence state, and the page tool hint. The presence line reads `off: the host has no Realtime authority` when the build has none. The Database inspector lists the two Comments tables as contributed tables.
