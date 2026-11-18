---
title: Serve a sitemap and robots.txt
description: Turn on /sitemap.xml and /robots.txt with one vitehub() option. ViteHub lists your pages, your Content pages, and the pages that you add in server/sitemap.ts.
navigation.title: Sitemap and robots.txt
navigation.order: 48.5
navigation.group: Deployment hosts
icon: i-lucide-map
---

A sitemap tells search engines which pages your site has. Set `seo: { sitemap: true }` in `vitehub()`. `publicUrl` gives the origin of the URLs; without it, each request gives the origin:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { publicUrl: 'https://shop.example.com', seo: { sitemap: true } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ publicUrl: 'https://shop.example.com', seo: { sitemap: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ publicUrl: 'https://shop.example.com', seo: { sitemap: true } })],
})
```
:::
::

ViteHub then serves two files on every host:

- `/sitemap.xml` lists each page once, sorted by URL.
- `/robots.txt` lets every crawler in and names the sitemap. When your app has its own `public/robots.txt` or a `server/routes/robots.txt.ts` route, ViteHub keeps yours. `robots: false` serves none.

The sitemap gets its pages from:

| Source | Pages |
| --- | --- |
| Nuxt pages | Each page in `app/pages/` without a dynamic part. `pages/about.vue` is listed. `pages/products/[slug].vue` is not. |
| Prerender routes | Each path in `nitro.prerender.routes`, and each route rule with `prerender: true` and no `*`. |
| [Content](/docs/content/seo#sitemap-and-robotstxt) | Each published Content page with a URL, with its `lastmod`. When `authorize` blocks readers who are not signed in, Content pages are not listed. |
| `server/sitemap.ts` | The pages that you return from `defineSitemap()`. |

ViteHub never lists a Nuxt page or prerender route that starts with `/api/` or `/_`, or that has a file extension, such as `/feed.xml`. Content pages and `server/sitemap.ts` entries are listed as they are: you chose them.

## Add pages from your data

ViteHub cannot know the URL of a page with a dynamic part, such as one page for each product. Return those pages from `server/sitemap.ts`:

```ts [server/sitemap.ts]
import { defineSitemap } from 'vite-hub/seo'

const products = [
  { slug: 'kettle', updatedAt: new Date('2026-11-10') },
  { slug: 'teapot', updatedAt: new Date('2026-11-12') },
]

export default defineSitemap(async () => products.map(product => ({
  loc: `/products/${product.slug}`,
  lastmod: product.updatedAt,
})))
```

`defineSitemap()` takes a list, or a function that returns the list on each request. Each entry has:

- `loc`: a path that starts with `/`, such as `/products/kettle`, or a full `https://` URL. ViteHub puts the origin and the app base before a path.
- `lastmod` (optional): when the page last changed, as a `Date` or a date string.

An entry without a valid `loc` or `lastmod` makes `/sitemap.xml` fail with `SEO_SITEMAP_ENTRY_INVALID`.

## Leave pages out

`exclude` lists path prefixes to leave out of the sitemap. A prefix also leaves out the paths below it:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { publicUrl: 'https://shop.example.com', seo: { sitemap: { exclude: ['/admin', '/account'] } } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ publicUrl: 'https://shop.example.com', seo: { sitemap: { exclude: ['/admin', '/account'] } } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ publicUrl: 'https://shop.example.com', seo: { sitemap: { exclude: ['/admin', '/account'] } } })],
})
```
:::
::

`/admin` and `/admin/orders` are left out. `/administrators` stays. `exclude` does not block crawlers: `/robots.txt` still allows every path.

## List only your own pages

`pages: false` turns off the Nuxt pages and the prerender routes. The sitemap then holds only the Content pages and the entries of `server/sitemap.ts`. Use it when only some pages may be indexed:

```ts [server/sitemap.ts]
import { defineSitemap } from 'vite-hub/seo'

const indexed = ['/', '/docs', '/docs/get-started']

export default defineSitemap(indexed.map(loc => ({ loc })))
```

The function form runs on each request, so it can read runtime config, such as a switch that turns indexing on for one deployment only. Return `[]` to serve an empty sitemap.

## Keep crawlers out of paths

`robots: { disallow }` lists paths that `/robots.txt` keeps crawlers out of:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { seo: { sitemap: { pages: false }, robots: { disallow: ['/api/'] } } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ seo: { sitemap: { pages: false }, robots: { disallow: ['/api/'] } } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ seo: { sitemap: { pages: false }, robots: { disallow: ['/api/'] } } })],
})
```
:::
::

```txt [/robots.txt]
User-agent: *
Disallow: /api/

Sitemap: https://drop.example.com/sitemap.xml
```

`seo: { robots: { disallow } }` without `sitemap` serves only `/robots.txt`, with no `Sitemap` line unless Content serves one.

## Rules and limits

- Without `publicUrl`, URLs use the origin of each request, as in `vite dev`. Behind a proxy that ends TLS, set `trustProxy` so they start with `https://`. A build that prerenders `/sitemap.xml` or `/robots.txt` has no request, so it needs `publicUrl` and fails with `SEO_PUBLIC_URL_MISSING` without it.
- With `seo.sitemap`, ViteHub serves `/sitemap.xml` and `/robots.txt` for the whole app, so Content does not add its own. The `robots.disallow` paths of `defineContent({ seo })` still go into `/robots.txt`, after those of `seo.robots`. `defineContent({ seo: { sitemap: false } })` keeps Content pages out of the sitemap.
- Your own `/sitemap.xml` server route fails the build with `SEO_SITEMAP_ROUTE_EXISTS`. Move its pages to `server/sitemap.ts`.
- One sitemap file holds at most 50,000 URLs. Above that, `/sitemap.xml` fails with `SEO_SITEMAP_TOO_LARGE`.
- With a Nuxt `app.baseURL` other than `/`, the sitemap is at `<baseURL>sitemap.xml` and ViteHub serves no `/robots.txt`: the app does not own the robots.txt of its host.
- Pages that a prerender finds by following links are not listed. List them in `nitro.prerender.routes` or return them from `server/sitemap.ts`.
