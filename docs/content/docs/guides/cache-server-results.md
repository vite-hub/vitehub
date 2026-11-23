---
title: Cache server results with tags
seo.title: "Nitro cache tags and invalidateTag()"
description: Cache an API call or a route in Nitro's cache, clear related entries with tags, and serve the stored value when the API fails.
navigation.title: Cache server results
navigation.order: 16
navigation.group: Storage
icon: i-lucide-timer-reset
---

Nitro caches the result of a server function or a route with `defineCachedFunction()` and `defineCachedHandler()`. ViteHub adds two things to them: tags, which clear related entries together, and `staleIfError`, which returns the stored value when the call fails.

## Turn on the cache

Set `cache: true`. ViteHub then keeps the cache in the store of the host: Workers KV on Cloudflare, Vercel Runtime Cache on Vercel, Deno KV on Deno, and a folder in `.vitehub/data/cache` on Node and in development.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { cache: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ cache: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ cache: true })],
})
```
:::
::

On Cloudflare, the build needs the id of a KV namespace. To keep the cache in the app's KV store on any host, set `cache: { driver: 'kv' }`. See [Nitro cache in KV](/docs/kv/configure#nitro-cache-in-kv) and the [`cache` option](/docs/reference/config-options#vite-integration-options).

## Clear related entries with tags

Tags clear related cache entries together. Import `defineCachedFunction()` and
`defineCachedHandler()` from `vite-hub/cache`. They take Nitro's options, plus
`tags`:

```ts [server/utils/posts.ts]
import { defineCachedFunction } from "vite-hub/cache"

export const getPost = defineCachedFunction(
  async (id: string) => {
    const response = await fetch(`https://api.example.com/posts/${id}`)
    return response.json()
  },
  { maxAge: 3600, getKey: (id: string) => id, tags: (id: string) => ["posts", `post:${id}`] },
)
```

Call `invalidateTag()` after the data changes:

```ts [server/api/posts/[id].put.ts]
import { defineHandler, getRouterParam } from "nitro/h3"
import { invalidateTag } from "vite-hub/cache"

export default defineHandler(async (event) => {
  // Save the post, then:
  await invalidateTag(`post:${getRouterParam(event, "id")}`)
  return { ok: true }
})
```

- `tags` is a list, or a function of the cached function's arguments. For
  `defineCachedHandler()`, the function gets the event.
- `invalidateTag()` takes one tag or a list. The next call of each entry with
  one of these tags runs the function again. It does not serve the old value,
  also with `swr: true`. Entries without these tags do not change.
- A result is not stored when one of its tags is invalidated while the function
  runs.
- ViteHub stores one record per tag in the `cache` mount, under `tags:` and
  the URI-encoded tag, with no TTL. Each read of a tagged entry reads its tag records. It
  never lists keys, so tags work with every `cache` driver.
- Cloudflare KV can take up to 60 seconds to show a new tag record in other
  locations. Until then, those locations can serve the old entry.
- Vercel Runtime Cache can evict any record, also a tag record. An entry whose
  tag record was evicted can come back until its `maxAge` ends.
- Without the `cache` option, Nitro keeps the cache in memory, and the tag
  records too. Each server instance then has its own tags.
- In Nuxt with `experimental.nitroAutoImports` on, `invalidateTag()` is
  auto-imported when `cache` is on. Nitro's `defineCachedFunction()` and
  `defineCachedHandler()` keep their own auto-imports and have no `tags`, so
  import the ViteHub ones from `vite-hub/cache`.

## Serve the stored value when a call fails

An exchange-rate API, a price feed, or a GitHub read can fail for a few
minutes. Set `staleIfError` to the number of seconds after `maxAge` during
which a call that throws returns the stored value instead of the error:

```ts [server/utils/rates.ts]
import { defineCachedFunction } from "vite-hub/cache"

export const getRates = defineCachedFunction(
  async (base: string) => {
    const response = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`)
    if (!response.ok) throw new Error(`Frankfurter answered ${response.status}`)
    const body: { rates: Record<string, number> } = await response.json()
    return body.rates
  },
  { maxAge: 60 * 60 * 12, staleIfError: 60 * 60 * 24 * 7, getKey: (base: string) => base },
)
```

For 12 hours, `getRates("USD")` returns the stored rates. After that, it calls
the API again. When the API throws, it returns the stored rates for up to 7
more days, and the next call tries the API again.

- The error goes to `onError`, or to the console as a warning.
- A call that throws keeps the stored entry and its time. It does not start a
  new `maxAge`.
- With nothing stored, or after `maxAge` plus `staleIfError`, the call throws.
- The stored entry stays in the `cache` mount, or in your `storage`, for
  `maxAge` plus `staleIfError`.
- `staleIfError` with `serialize` fails when you define the function.
- It works with `swr: true`, `tags`, and `expire()`. After `invalidateTag()`,
  a call that throws also returns the stored value. `invalidate()` deletes the
  entry, so nothing is left to return.
- The window starts from the `maxAge` of the function, not from Nitro's
  `cache.defaults`.
- `defineCachedHandler()` has no `staleIfError`. Cache the call that can fail
  with `defineCachedFunction()` and call it from the handler.

## Inspect the cache

`vitehub cache list`, `get`, and `delete` read and clear the entries on the dev server or on a deployed app. See [Read and invalidate the cache](/docs/cli/primitives#read-and-invalidate-the-cache).
