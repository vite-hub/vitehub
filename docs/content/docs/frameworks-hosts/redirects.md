---
title: Redirect to one canonical address
description: Send www, http, and trailing-slash variants of each page to one address on every host.
navigation.title: Canonical redirects
navigation.order: 48.5
navigation.group: Deployment hosts
icon: i-lucide-signpost
---

A site often answers on more than one address: `www.example.com` and `example.com`, `http://` and `https://`, `/pricing` and `/pricing/`. Search engines count each address as a different page, and the microphone, the clipboard, and passkeys need `https://`. Set `redirects` to send every request to one canonical address.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    redirects: {
      host: 'example.com',
      https: true,
      trailingSlash: 'remove',
    },
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
      redirects: {
        host: 'example.com',
        https: true,
        trailingSlash: 'remove',
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      redirects: {
        host: 'example.com',
        https: true,
        trailingSlash: 'remove',
      },
    }),
  ],
})
```
:::
::

With this config, `http://www.example.com/pricing/?plan=pro` gets one redirect to `https://example.com/pricing?plan=pro`.

- `host` sends every other host, such as `www.example.com`, to `example.com`. Write the host name only, without `https://`.
- `https: true` sends `http://` requests to `https://`.
- `trailingSlash: 'remove'` sends `/pricing/` to `/pricing`. `'add'` does the opposite. It changes page paths only: `GET` and `HEAD` requests that are not under `/api/` or `/_` and have no file extension, so API clients and webhooks keep their paths.
- `GET` and `HEAD` requests get `301`. Other methods get `308`, which keeps the method and the body.

## Requests that keep their address

These requests keep their host and scheme:

- `vite dev` and `nuxt dev`. They never redirect.
- Local names, such as `localhost`, `app.localhost`, or a container name without a dot, and IP addresses, such as a health check to `10.0.0.5`.
- Preview hosts: `*.workers.dev`, `*.pages.dev`, `*.vercel.app`, `*.netlify.app`, `*.deno.dev`, and `*.deno.net`.

Add your own preview hosts with `previewHosts`. `*.` matches every subdomain.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    redirects: {
      host: 'example.com',
      https: true,
      previewHosts: ['staging.example.com', '*.preview.example.com'],
    },
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
      redirects: {
        host: 'example.com',
        https: true,
        previewHosts: ['staging.example.com', '*.preview.example.com'],
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      redirects: {
        host: 'example.com',
        https: true,
        previewHosts: ['staging.example.com', '*.preview.example.com'],
      },
    }),
  ],
})
```
:::
::

## Behind a proxy

The redirect reads the client's scheme from `X-Forwarded-Proto` and the client's host from `X-Forwarded-Host`, so a Node server behind a proxy that ends TLS does not redirect in a loop. Make the proxy send both headers, or send the client's `Host` header. A client that sends these headers itself only skips its own redirect.

## Static files

Each host serves static files, such as prerendered pages, in its own way:

| Host | Static files |
| --- | --- |
| Node, Deno | Nitro serves them, so they redirect like every route. |
| Cloudflare | Cloudflare serves files before the Worker runs. ViteHub sets `assets.run_worker_first` so the Worker redirects first and then serves the file. The hashed build files, such as `/_nuxt/*`, skip the Worker. With `trailingSlash`, it also sets `assets.html_handling` to the same direction. A key that your Wrangler config sets is kept. |
| Vercel, Netlify | The host serves them without the server. Both hosts already send `http://` to `https://`. Redirect other hosts to your domain in the host's domain settings. |

On Cloudflare, `run_worker_first` makes each page and file request a Worker request, except the hashed build files.

## Moved pages

`redirects` does not move single pages. Use Nitro `routeRules` for that:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  routeRules: {
    '/getting-started': { redirect: { to: '/guide/installation', status: 301 } },
    '/blog/**': { redirect: { to: '/posts/**', status: 301 } },
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
  nitro: {
    routeRules: {
      '/getting-started': { redirect: { to: '/guide/installation', status: 301 } },
      '/blog/**': { redirect: { to: '/posts/**', status: 301 } },
    },
  },
  plugins: [
    vitehub(),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  nitro: {
    routeRules: {
      '/getting-started': { redirect: { to: '/guide/installation', status: 301 } },
      '/blog/**': { redirect: { to: '/posts/**', status: 301 } },
    },
  },
  plugins: [
    vitehub(),
  ],
})
```
:::
::

On Cloudflare, static files are served before the Worker runs. So ViteHub also writes these rules to the `_redirects` file of the static files, and a moved page that is a static file gets the same redirect. With the rules above, the file has these lines:

```txt [.output/public/_redirects]
/getting-started /guide/installation 301
/getting-started/ /guide/installation 301
/blog /posts 301
/blog/ /posts 301
/blog/* /posts/:splat 301
```

Nitro also redirects `/getting-started/` and `/blog`, so these get lines too.

- A rule with no `status` gets `307`, as on the server.
- When the app has its own `public/_redirects`, its lines stay first, and Cloudflare uses the first line that matches.
- `_redirects` cannot hold some rules: a route with an HTTP method, such as `GET /login`, a pattern such as `/files/*.pdf`, `redirect: false`, a target with a query, such as `/sale?from=promo`, or a status other than 301, 302, 303, 307, or 308. The build leaves out such a rule, and each wider rule that would match its paths first, and prints the `VITE_HUB_REDIRECTS_FILE_RULE_SKIPPED` hint. The Worker still redirects these paths when no static file is there.

Do not prerender a moved path. A prerendered redirect is a page that refreshes, not a real redirect.
