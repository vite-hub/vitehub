---
title: Content draft preview
description: Render draft documents through your real pages for one browser with a signed preview cookie, while the public site keeps serving published content.
navigation.title: Draft preview
navigation.order: 8
icon: i-lucide-eye
---

A preview cookie lets one browser see drafts through your real pages. Requests without it read `published`, and the site shows no editing UI. Your app sets the cookie from its own route. An editor that shows one document in a frame uses [preview frames](#preview-frames).

## Enable preview

`content.preview.enable(event)` signs a token and sets it as a cookie on the response. `content.preview.disable(event)` clears it. The routes below preview this `posts` collection:

```ts [server/content.ts]
import { cms } from 'vite-hub/cms'
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  authorize: ({ user, action }) => action === 'read' || (action === 'read-draft' && Boolean(user)),
  collections: {
    posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string() } }),
  },
})
```

This policy lets everyone read `/api/content/**` and signed-in users read drafts. Replace it with your app's preview access rules.

```ts [server/api/preview.post.ts] fragment
import content from '../content'

export default defineEventHandler(async (event) => {
  const user = await getUser(event) // your Auth session
  if (!await content.can({ user, collection: 'posts', action: 'read-draft' }))
    throw createError({ statusCode: 403 })
  return await content.preview.enable(event) // { setCookie, expiresAt }
})
```

```ts [server/api/preview.delete.ts]
import { defineEventHandler } from 'h3'
import content from '../content'

export default defineEventHandler(event => content.preview.disable(event))
```

`enable()` is trusted server API, like `save()` and `publish()`, and skips `authorize`. Check `content.can()` with `read-draft` first. The token previews every collection, so check each one the user may open, or the ones the page renders.

| Call | Behavior |
| --- | --- |
| `content.preview.enable(event, { maxAge? })` | Adds the preview cookie to the response and returns `{ setCookie, expiresAt }`. `maxAge` is in seconds: 60 to 86400, default 3600. |
| `content.preview.disable(event)` | Adds a cookie that expires now. Returns `{ setCookie, expiresAt: null }`. |
| `content.preview.run(event, callback)` | Runs `callback` in preview if the event has a valid cookie, else unchanged. |
| `content.preview.active()` | `true` in a request with a valid preview cookie, where every read uses `draft`. `false` in a preview frame and with [`?vitehub-content-published`](#published-reads). |
| `content.preview.sign({ collection, id, maxAge? })` | Returns `{ token, expiresAt }` for a [preview frame](#preview-frames) of one document, without a cookie. Check `content.can({ user, collection, id, action: 'read-draft' })` first. |
| `content.preview.frame()` | In a preview frame request, `{ collection, id, document? }`: the signed document and the on-screen version the frame posted. Else `undefined`. |

`event` is an H3 event or a Web `Request`. With a `Request`, set the returned `setCookie` header yourself.

## What a preview request reads

With a valid cookie, every Content read uses `draft`:

- `/api/content/**`, so `createContentClient()` in the browser, and server fetches that forward the cookie.
- `content.get()`, `content.list()`, `content.navigation()`, `content.search()`, and `content.handler()`.
- `content.collection(name).get()`, `list()`, and the Collection handler. An explicit `{ ref: 'published' }` still reads `published`.

`status()`, `revisions()`, and plugin methods such as SQL queries do not change. A save shows on the next preview request, because preview reads check the draft head and refresh when it moved.

Each request gets its own grant through `AsyncLocalStorage`, so parallel preview and public requests never see each other's content.

## Where the request is scoped

A generated Nitro plugin wraps Nitro's request entry. The whole request runs in the preview scope: route rules, middleware, cached routes, pages, and server routes. Requests without the cookie pass through. Your server code does not change.

Preview requires Nitro 3. This works with the `vitehub()` Vite plugin on Nitro 3 and the `vite-hub/nuxt` module on Nuxt 5, with no Nitro experimental flag. Nuxt `useFetch()` during SSR forwards the cookie, so the rendered page shows the draft too.

Preview needs the host's `AsyncLocalStorage` request context. On Cloudflare Workers, turn on the `nodejs_als` compatibility flag in the Worker configuration. Without this API, ViteHub reports a configuration error before it serves requests.

Call `content.preview.run(event, callback)` yourself only for requests outside Nitro, such as a test or a custom server.

## Preview frames

A preview frame renders a document's page through your routes with the on-screen fields and body, before anything saves. The Content page preview of the Console that the app served used it, and is removed. The collection needs a `url` on the app origin, such as `documents({ url: '/blog/:id' })`.

```ts [server/content.ts] fragment
posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string() } }),
```

```ts [server/routes/blog/[...id].get.ts] fragment
const post = await content.collection('posts').get(id) // the document on screen in a preview frame
return html`<h1 ${contentField('posts', post.id, 'title')}>${post.data.title}</h1>`
```

A Draft view posts a form to the page URL with `?vitehub-content-preview`. The form field of that name holds `{ token, document? }` as JSON: a `content.preview.sign({ collection, id })` token and the on-screen version. Sign it only after `content.can()` allows `read-draft` of that document. The Nitro plugin checks the token and runs the page as a `GET` of its URL, without the parameter.

A frame token reads the draft of its one document only:

- `content.collection(name).get(id)` and that collection's `list()`, without `ref` or `revision`, return the posted version of the signed document, or its stored draft if the form has none. Other documents in `list()` are `published`.
- Every other read is `published`: other documents and collections, never-published drafts, `raw()`, Comark reads such as `content.get()`, `content.list()`, `queryCollection()`, `navigation()`, and `search()`, and `/api/content/**`. A page that reads the signed document through Comark shows its published version.
- An explicit `{ ref: 'draft' }` or `{ revision }` in server code is trusted and reads what it names. Do not pass it from request input.
- A form that posts another document, or a token changed in any part, gets `403`. Frame tokens and preview cookie tokens are not interchangeable. Use `enable()` to preview the whole site.
- Nested requests, such as `/api/content/**` during SSR, keep the frame scope. A preview cookie does not widen it.
- Nothing is stored. The response is `private, no-store` and `noindex`, and skips Nitro's cache. In Nuxt, the page keeps its payload in the HTML, even with a `cache`, `swr`, or `isr` rule. A later `_payload.json` request cannot carry the form, so it would read `published`.
- A form without a valid token, or with a cross-site `Sec-Fetch-Site` or `Origin`, gets `403`. `Origin` must match the page URL and protocol, which comes from `x-forwarded-proto` behind a proxy or from the Web request URL. The parameter on a `GET` grants nothing. The token is in the form body, never the URL. A cross-site form is refused before its body is read. The body is at most 1 MiB. The plugin counts bytes as they arrive, ignores `Content-Length`, and answers `403` at the first byte over.

A `GET` of the page with `?vitehub-content-published` loads it as a guest sees it.

A same-origin redirect, such as a locale, canonical, or sign-in redirect, keeps the document on screen. The browser follows it with the same form, so the token and document stay in the body, never in a URL or cookie:

- The plugin answers with a `307` to the same `Location`, adding `?vitehub-content-preview=<hop>`. The rest of the query and the fragment stay. A `307` keeps the method and body, so the browser posts the form to the next page, and the plugin checks the token and document again. Each page runs as a `GET` of its URL, without the form.
- The browser keeps the cookies. It sets each redirect's `Set-Cookie`, and sends each page its cookies for that URL by `Path`, `Domain`, `Secure`, `SameSite`, and expiry. The server never copies a `Cookie` header between URLs, so a cookie for `/admin` never reaches `/account` through a redirect.
- Same origin means the scheme, host, and port of the frame URL, from the `Host` header and the protocol above. `X-Forwarded-Host` does not count. A cross-origin redirect, a sixth redirect, or an invalid `Location` gets a private error page before the browser can post the form there. Its `<meta name="vitehub-content-preview-error">` (`contentPreviewErrorName`) holds the message.
- The page sees a `GET`, and the frame address has the parameter. A client router that reads the query sees `vitehub-content-preview`. A redirect from a page script or `<meta http-equiv="refresh">` loads the next page with a `GET` without the form, so it reads `published`.
- Each request in the chain has the `Referer` and `Origin` of the page that posted the form, as browsers send for redirects. A Content Security Policy of that page whose `form-action` does not allow the site origin blocks the form and its redirects.

Pages must allow a frame from their own origin: `frame-ancestors 'self'` or none, and no `X-Frame-Options: DENY`. Data the page fetches from the browser after load has no frame scope. It reads `published`, or `draft` with a preview cookie.

## Published reads

A browser with a preview cookie reads drafts on every page. A request with `?vitehub-content-published` reads `published` with the same cookie:

- Every Content read without `ref` or `revision` is `published`, and `content.preview.active()` is `false`. Nested requests and `content.preview.run()` calls stay `published`. The cookie does not widen them.
- A request whose `Referer` is a same-origin page with the parameter is `published` too, such as a `fetch()` from the Published view. Without a `Referer`, for example with `Referrer-Policy: no-referrer`, or after client-side navigation to a URL without the parameter, the cookie applies again.
- An HTTP redirect to the same host name, such as a canonical or locale redirect, gets the parameter in its `Location`. The rest of the URL stays, so the landing page and each later redirect read `published` too. The host comes from the request URL or `X-Forwarded-Host`. A redirect to another host does not change and gets no token. Neither does a redirect from a page script or `<meta http-equiv="refresh">`.
- The cookie does not change. The response sets no cookie, and requests without the parameter still preview the whole site.
- The parameter only removes draft access. It needs no token and never reads a draft or posted document. A frame form needs its own token.
- The page sees its URL with the parameter. The response is `private, no-store` and `noindex`, and skips Nitro's cache, so the page shows current published content.
- An explicit `{ ref: 'draft' }` or `{ revision }` in server code is trusted and reads what it names.

`contentPreviewPublishedParameter` from `vite-hub/content` and `vite-hub/content/client` holds the parameter name.

## Signing key

Content signs preview tokens with HMAC-SHA256 and `VITEHUB_CONTENT_KEY`: 32 random bytes as base64 or hex.

```sh
export VITEHUB_CONTENT_KEY="$(openssl rand -base64 32)"
```

Content reads it from the process environment, then the Cloudflare Worker environment. Every instance needs the same key.

| Situation | Behavior |
| --- | --- |
| Key set | Tokens verify on every instance until they expire. |
| No key, `NODE_ENV` is `development` or `test` | Content uses a random key for this process and warns once. Tokens break on restart. |
| No key in any other environment | `enable()` throws `CONTENT_R0010`. Preview cookies are ignored, so requests read `published`. |
| Key is not 32 bytes | `enable()` throws `CONTENT_R0010`. Preview cookies are ignored with one warning. |

Rotating the key ends every open preview. ViteHub has no app-wide secret to reuse. `BETTER_AUTH_SECRET` exists only with Auth, and `VITEHUB_CONNECTIONS_KEY` belongs to Connections.

## Cookie and token

The cookie is `vitehub-content-preview` with `Path=/`, `HttpOnly`, `SameSite=Strict`, and `Max-Age` set to the token lifetime. It is `Secure` unless the request used plain `http`, such as `http://localhost`. Behind a proxy, the protocol comes from `x-forwarded-proto`.

The token is `v1.<expiry>.<signature>`. The signature covers the expiry and a purpose string. Content checks it in constant time with `crypto.subtle.verify()`. A bad signature, a past expiry, or an expiry over 24 hours ahead is ignored.

::warning
The token is not bound to a user or session. Anyone with the cookie reads drafts until it expires. `disable()` clears it only in the browser that sends the request. Keep `maxAge` short.
::

## Caching

Preview responses have `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Content sets them after your handler, so route headers cannot make a draft public. Other responses keep their headers.

Nitro's cache skips preview requests. Cached handlers, `cache` or `swr` route rules, and cached functions run directly. They never read or write a cache entry, and never share an in-flight render with a public request. So pages that read Content can use `swr` safely. Nitro has no global bypass hook, so ViteHub puts a small module in front of Nitro's cache module.

::warning
A CDN or reverse proxy caches by URL and does not know the cookie. If it caches HTML, make it skip its cache for requests with the `vitehub-content-preview` cookie. Otherwise the previewer gets the cached published page. `private, no-store` stops a correct CDN from storing the draft response.
::

## Branch, commit, and pull request previews

A `github()` Source can show any allowed ref at a URL. Set `previews: true`:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { github } from 'vite-hub/source'

export default defineContent({
  sources: { docs: github({ repo: 'acme/docs', ref: 'main' }) },
  previews: true,
})
```

| URL | Reads |
| --- | --- |
| `/tree/feat/x/-/docs/kv` | The latest commit of the branch `feat/x`. The part `-` ends the branch name. |
| `/blob/<sha>/docs/kv` | One commit, by its full 40-character SHA. |
| `/pr/12/docs/kv` | The head commit of pull request 12. |

The page runs at `/docs/kv` through your real routes, and every read of the Source returns the commit of the ref. Internal links in the Comark tree get the prefix, so `/docs/next` becomes `/pr/12/docs/next`. `content.sources.current()` tells a page that it is a preview: `{ ref, kind, sha, pull, prefix, path, url }`, where `url` is the production URL.

Content asks `content.sources.allow()` first. A ref that it denies gets your app's own 404, the same answer as for any unknown path. The draft branch of the CMS, its publish branches, and fork pull requests without the `preview:enabled` label need the preview cookie or a link from `content.sources.sign()`.

With `authorize`, a preview URL also asks it for `read`, as `/api/content/**` does, unless the preview cookie or a signed link opened the ref. A denied request gets `401` or `403`, and an allowed one gets `Cache-Control: private, no-store`. `access: 'public'` skips the check.

A preview response has `X-Robots-Tag: noindex` and a canonical `Link` header to the production URL. Its `Cache-Control` is `private, no-store` for the cookie or a signed link, `immutable` for a `/blob` commit in the published history, and one minute for other refs. These are upper bounds: shorter application `max-age` and `s-maxage` values and revalidation directives stay in place. A response with its own cache policy does not become immutable only because the Source commit is published. A response that your route marks `private`, `no-store`, or `no-cache`, or that sets a cookie, stays private. Nitro's cache skips preview requests. A ref that a signed link opened keeps the link token on its internal links and redirects.

In Nuxt, the client router does not know the prefix yet. A page that reads its route on the client sees the preview URL after hydration.

### Links for a pull request

`content.sources.previewLinks(12)` returns the `/pr/12/...` link of each page that pull request 12 adds or changes, from its GitHub file list. Removed files and files that are not pages are left out.

```ts fragment
const links = await content.sources.previewLinks(12, { site: 'https://docs.example.com' })
// { repo: 'acme/docs', sha, pull, access: 'pull', expiresAt: null,
//   pages: [{ key: 'docs/kv.md', path: '/docs/kv', url: 'https://docs.example.com/pr/12/docs/kv' }] }
```

`access` says how a reader opens the links. A pull request from the same repository, or a fork with the `preview:enabled` label, gets plain links. A private one, such as a CMS publish, gets `token`: each link has a token from `content.sources.sign()` that works for one hour, or `maxAge` seconds up to 24 hours. A fork without the label gets `fork` and plain links that open after a maintainer adds the label. Content never signs a fork pull request. Check Console access before you call it, as for `sign()`.

When the [CMS](/docs/cms/configure#pull-request-mode) publishes with `publish: 'pr'`, the result has `previews`, a signed link for each document with a `url`. The link shows the pull request when the page reads the `github()` Source, as when the CMS edits the files of the docs repository. Collections read `published` in a preview request.

The revisions of the Blob + Database store have no `/blob/<id>` URL. Their ids are not Git commits, so GitHub cannot check them. Use [draft preview](#enable-preview) or [preview frames](#preview-frames) for those.

### Comment preview links from GitHub Actions

`vitehub content previews comment --pr 12` prints the links as a Markdown comment. With `--post`, it creates one comment on the pull request and updates it on the next run. See [the CLI](/docs/content/cli#pull-request-previews).

ViteHub does not add a workflow for you, and deploys stay local. To comment from CI, add this workflow yourself. It [signs requests to the deployed app](/docs/development/console#sign-console-requests) and posts with the token of the workflow. Run `vitehub secret console-key ci`, set `VITEHUB_CONSOLE_KEY_CI` on the app with `console: { auth: 'token' }`, and store `VITEHUB_CONSOLE_PRIVATE_KEY_CI` as a GitHub Actions secret:

```yaml [.github/workflows/content-previews.yml]
name: Content previews
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  comment:
    # A fork pull request gets no secrets, so it gets no comment.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitehub content previews comment --pr ${{ github.event.pull_request.number }} --post --url https://docs.example.com
        env:
          VITEHUB_CONSOLE_PRIVATE_KEY_CI: ${{ secrets.VITEHUB_CONSOLE_PRIVATE_KEY_CI }}
          VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The app reads the pull request with its own `VITEHUB_GITHUB_TOKEN`. The workflow token only writes the comment. A pull request that the CMS opens also triggers the workflow when the CMS token is not the workflow token.

See [Limits and errors](/docs/content/limits-and-errors) for every Content error code.
