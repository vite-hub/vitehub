---
title: Content draft preview
description: Render draft documents through your real pages for one browser with a signed preview cookie, while the public site keeps serving published content.
navigation.title: Draft preview
navigation.order: 8
icon: i-lucide-eye
---

A preview cookie makes one browser read the `draft` ref through your real pages. Requests without it keep reading `published`, and the site shows no editing UI. Your app sets the cookie from its own route. The ViteHub Console content editor does not set it: its side browser uses [preview frames](#preview-frames) instead.

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
| `content.preview.active()` | `true` inside a request with a valid preview cookie, where every read uses `draft`. `false` in a preview frame and with [`?vitehub-content-published`](#published-reads). |
| `content.preview.sign({ collection, id, maxAge? })` | Returns `{ token, expiresAt }` for a [preview frame](#preview-frames) of that one document, without a cookie. Check `content.can({ user, collection, id, action: 'read' })` first. |
| `content.preview.frame()` | In a preview frame request, `{ collection, id, document? }`: the document its token signs and the version on screen that the frame posted. Otherwise `undefined`. |

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

## Preview frames

The document editor of the Console shows the page of a document in a side browser next to the editor. The page renders through your own routes, with the fields and body on screen, before anything saves. The collection needs a `url`, such as `documents({ url: '/blog/:id' })`, on the Console origin.

```ts [server/content.ts]
posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string() } }),
```

```ts [server/routes/blog/[...id].get.ts]
const post = await content.collection('posts').get(id) // the document on screen in a preview frame
return html`<h1 ${contentField('posts', post.id, 'title')}>${post.data.title}</h1>`
```

The Draft view posts a form to the page URL with `?vitehub-content-preview`. The form field of the same name holds `{ token, document? }` as JSON: a token from `content.preview.sign({ collection, id })`, 15 minutes in the Console, and the version of that document on screen. The Console signs it only after `content.can()` allows `read` of that document. The generated Nitro plugin checks the token and runs the page as a `GET` of its own URL, without the parameter.

A frame token reads the draft of its one document, and nothing else:

- `content.collection(name).get(id)` and `list()` of that collection, without `ref` or `revision`, return the posted version of the signed document, or its stored draft when the form has none. Every other document in `list()` is `published`.
- Every other read is `published`: other documents and collections, drafts that were never published, `raw()`, Comark reads such as `content.get()`, `content.list()`, `queryCollection()`, `navigation()`, and `search()`, and `/api/content/**`. A page that reads the signed document through Comark shows its published version.
- An explicit `{ ref: 'draft' }` or `{ revision }` in your server code is trusted server API and reads what it names, as outside preview. Do not pass it from request input.
- A form that posts any other document, or a token that is changed in any part, gets `403`. A frame token is not a preview cookie token, and a preview cookie token is not a frame token. Use `enable()` for a preview of the whole site.
- Nested requests in the same request, such as `/api/content/**` during SSR, keep the frame scope; a preview cookie does not widen it.
- Nothing is stored. The response is `private, no-store` and `noindex`, and Nitro's cache is bypassed.
- A form without a valid token, or with `Sec-Fetch-Site` or `Origin` from another site, gets `403`. `Origin` must match the page URL with its protocol, which comes from `x-forwarded-proto` behind a proxy or from the TLS connection. The parameter on a `GET` grants nothing. The token travels in the form body, never in the URL. A form from another site is refused before its body is read. The body may be 1 MiB at most: the plugin counts the bytes as they arrive, does not trust `Content-Length`, and stops reading and answers `403` at the first byte over the limit. On Nitro 2 it then closes the connection instead of reading the rest.

The Published view loads the page with a `GET` of `?vitehub-content-published`, as a guest sees it. Elements with `contentField()` attributes select their field in the editor, and top-level text fields change in place in the Draft view.

A same-origin redirect of the page, such as a locale, canonical, or sign-in redirect, is followed in the server inside the frame scope, up to five times, on Nitro 3 and on Nitro 2 (Nuxt 4). The redirect never reaches the browser, so the token and the document on screen stay with the request, and they never go into a URL or a cookie. The last page renders with the document on screen:

- Each page runs as a `GET` in the same server process: through Nitro's `fetch` on Nitro 3, and through Nitro's `localCall()` on Nitro 2, which also catches redirects that h3 writes to the Node response, such as `sendRedirect()` and route rule redirects. Following a redirect never sends a request to another host. The host that `X-Forwarded-Host` names counts as this server.
- A cookie that a redirect sets goes to the next page in its `Cookie` header by host-only or `Domain` scope, `Path`, `Secure`, `Max-Age`, and `Expires`. Public-suffix domains, including private suffixes such as `github.io`, are rejected. Cookies set within the chain with the same name under different domains or paths stay separate. The browser gets every `Set-Cookie` of the redirects, in order, with the last page. The cookies that the browser sent with the frame form go to every page on the original hostname, because a `Cookie` header does not say their paths; a cookie that the browser keeps for a narrower path than a later page can reach that page too. They never go to a different forwarded hostname, since their Domain scope is unknown. A matching redirect cookie replaces or expires incoming cookies by name, since their domain and path identities cannot be recovered; this can suppress a distinct incoming cookie with the same name. A host whose `Headers` has no `getSetCookie()` joins the cookies of a response into one header, which cannot be split safely; a redirect there that sets cookies gets the error page below.
- An HTML page gets a short inline script that sets the frame address to the page it landed on, with the fragment of the redirect. A client router then reads the route that the server rendered. A Content Security Policy that blocks inline scripts keeps the address that the frame posted to.
- A redirect to another origin, a sixth redirect, or a `Location` that is not valid gets a private error page instead of the page. Its `<meta name="vitehub-content-preview-error">` (`contentPreviewErrorName`) holds the message, and the Console shows it with **Retry**. The frame never shows another site, or a page without the document on screen, under the Draft label.

Pages must allow a frame from their own origin: `frame-ancestors 'self'` or no `frame-ancestors`, and no `X-Frame-Options: DENY`. Data that the page fetches from the browser after it loads does not carry the frame scope: it reads `published`, or `draft` with a preview cookie.

## Published reads

A browser with a preview cookie reads drafts on every page. A request with `?vitehub-content-published` reads `published` instead, with the same cookie, such as the Published view of the Console:

- Every Content read without `ref` or `revision` is `published`, and `content.preview.active()` is `false`. Nested requests and `content.preview.run()` calls in the same request stay `published`: the cookie does not widen them.
- A request whose `Referer` is a page of the same origin with the parameter is `published` too, such as a `fetch()` from the page in the Published view. A page that sends no `Referer`, for example with `Referrer-Policy: no-referrer`, or a client-side navigation to a URL without the parameter, reads with the cookie again.
- An HTTP redirect from it to the same host name, such as a canonical or locale redirect, gets the parameter in its `Location`. The rest of the URL stays as it is, so the page the browser lands on, and each later redirect, reads `published` too. The host comes from the request URL or `X-Forwarded-Host`. A redirect to another host is not changed and gets no token. A redirect from a page script or a `<meta http-equiv="refresh">` is not changed.
- The cookie stays as it is: the response sets no cookie, and requests without the parameter preview the whole site as before.
- The parameter only takes draft access away. It needs no token, and it never reads a draft or a posted document. A frame form needs its own token.
- The page sees its URL with the parameter. The response is `private, no-store` and `noindex`, and Nitro's cache is bypassed, so the page shows the published content now, not a cached copy.
- An explicit `{ ref: 'draft' }` or `{ revision }` in your server code is trusted server API and reads what it names.

`contentPreviewPublishedParameter` from `@vite-hub/content` and `@vite-hub/content/client` holds the parameter name.

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
