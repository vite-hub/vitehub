---
title: Content draft preview
description: Render draft documents through your real pages for one browser with a signed preview cookie, while the public site keeps serving published content.
navigation.title: Draft preview
navigation.order: 5
icon: i-lucide-eye
---

A preview cookie makes one browser read the `draft` ref through your real pages. Requests without it keep reading `published`, and the site shows no editing UI. The ViteHub Console content editor sets the cookie for its preview frame. You can also set it from your own route.

## Enable preview

`content.preview.enable(event)` signs a token and sets it as a cookie on the response. `content.preview.disable(event)` clears it.

```ts [server/api/preview.post.ts]
import { content } from '../content'

export default defineEventHandler(async (event) => {
  const user = await getUser(event) // your Auth session
  if (!await content.can({ user, collection: 'posts', action: 'read' }))
    throw createError({ statusCode: 403 })
  return await content.preview.enable(event) // { setCookie, expiresAt }
})
```

```ts [server/api/preview.delete.ts]
import { content } from '../content'

export default defineEventHandler(event => content.preview.disable(event))
```

`enable()` is trusted server API, like `save()` and `publish()`. It does not call `authorize`, so check `content.can()` with the `read` action first. The token previews every collection of the runtime, so check each collection the user may open, or the ones the page renders.

| Call | Behavior |
| --- | --- |
| `content.preview.enable(event, { maxAge? })` | Appends the preview cookie to the response and returns `{ setCookie, expiresAt }`. `maxAge` is in seconds: default 3600 (one hour), from 60 to 86400. |
| `content.preview.disable(event)` | Appends a cookie that expires now. Returns `{ setCookie, expiresAt: null }`. |
| `content.preview.run(event, callback)` | Runs `callback` in preview when the event carries a valid cookie. Otherwise it runs unchanged. |
| `content.preview.active()` | `true` inside a preview request. |

`event` is an H3 event or a Web `Request`. A `Request` has no response, so set the returned `setCookie` header yourself.

## What a preview request reads

Inside a request with a valid cookie, every Content read uses `draft`:

- `/api/content/**`, so `createContentClient()` in the browser and server fetches that forward the cookie.
- `content.get()`, `content.list()`, `content.navigation()`, `content.search()`, and `content.handler()`.
- `content.collection(name).get()`, `list()`, and the Collection handler. An explicit `{ ref: 'published' }` still reads `published`.

`status()`, `revisions()`, and plugin methods such as SQL queries do not change. A save during preview shows on the next request: preview reads check the draft head and refresh the draft instances when it moved.

Each request gets its own grant through `AsyncLocalStorage`, so concurrent preview and public requests never see each other's content.

## Where the request is scoped

ViteHub generates a Nitro plugin next to the Content route. It wraps Nitro's request entry, so the whole request runs inside the preview scope: route rules, middleware, cached routes, pages, and server routes. Requests without the cookie pass straight through. Your server code needs no changes.

This works the same with the `vitehub()` Vite plugin on Nitro 3 and with the `vite-hub/nuxt` module on Nuxt 4 (Nitro 2). It needs no Nitro experimental flag. Nuxt pages that load data with `useFetch()` during SSR forward the cookie to the server route, so the rendered page shows the draft too.

Preview needs the host's `AsyncLocalStorage` request context. Cloudflare Workers users must enable the `nodejs_als` compatibility flag in the Worker configuration. ViteHub reports a configuration error when this API is unavailable, before serving requests.

Call `content.preview.run(event, callback)` yourself only for requests that do not go through Nitro, such as a test or a custom server.

## Signing key

Content signs preview tokens with HMAC-SHA256 and the key in `VITEHUB_CONTENT_KEY`: 32 random bytes as base64 or hex.

```sh
export VITEHUB_CONTENT_KEY="$(openssl rand -base64 32)"
```

Content reads it from the process environment, then from the Cloudflare Worker environment. Every instance that serves the site needs the same key.

| Situation | Behavior |
| --- | --- |
| Key set | Tokens verify on every instance until they expire. |
| No key, `NODE_ENV` is `development` or `test` | Content uses a random key for this process and warns once. Tokens stop working after a restart. |
| No key in any other environment | `enable()` throws `CONTENT_R0010`. Preview cookies are ignored, so requests read `published`. |
| Key is not 32 bytes | `enable()` throws `CONTENT_R0010`. Preview cookies are ignored with one warning. |

Rotating the key ends every open preview. ViteHub has no app-wide secret to reuse: `BETTER_AUTH_SECRET` exists only with Auth, and `VITEHUB_CONNECTIONS_KEY` belongs to Connections.

## Cookie and token

The cookie is `vitehub-content-preview` with `Path=/`, `HttpOnly`, `SameSite=Strict`, and `Max-Age` set to the token lifetime. It is `Secure` unless the request came over plain `http`, such as `http://localhost`. The protocol comes from `x-forwarded-proto` when a proxy sets it.

The token is `v1.<expiry>.<signature>`. The signature covers the expiry and a purpose string, and Content compares it in constant time through `crypto.subtle.verify()`. A token with a bad signature, a past expiry, or an expiry more than 24 hours ahead is ignored.

The token is not bound to a user or a session. Anyone who holds the cookie reads drafts until it expires, and `disable()` clears it only in the browser that sends the request. Keep `maxAge` short.

## Caching

Preview responses carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Content sets them after your handler runs, so route headers cannot make a draft public. Responses without the cookie keep their own headers.

Nitro's cache skips preview requests. Cached handlers, route rules with `cache` or `swr`, and cached functions run directly during a preview request: they never read a cached entry, never write one, and never share an in-flight render with a public request. Pages that read Content can use `swr` safely. ViteHub inserts a small module in front of Nitro's cache module to do this, because Nitro has no global bypass hook.

A CDN or reverse proxy in front of the app cannot see this. It caches by URL and does not know what the cookie means. If it caches HTML, configure it to bypass its cache when the request has the `vitehub-content-preview` cookie. Otherwise the previewer gets the cached published page. The `private, no-store` header keeps a correct CDN from storing the draft response itself.

See [Limits and errors](/docs/content/limits-and-errors) for every Content error code.
