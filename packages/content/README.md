# @vite-hub/content

ViteHub content integration for Comark Content: read-only Sources and editable document collections.

Pass ViteHub Source definitions, registered names, readers, reader factories, or native Comark raw Sources. A single source becomes a named `default` instance. Named sources are composed with Comark's `contentHub()`, with ViteHub adapters for named cache operations and positional search arguments.

```ts
import { defineContent } from "@vite-hub/content"
import fs from "comark-content/sources/fs"

export const content = defineContent({
  sources: {
    docs: fs("./docs"),
    blog: fs("./blog"),
  },
})
```

`defineContent()` forwards Comark plugins to each content instance. Install the
plugin you need and pass it in `plugins`; plugin options are evaluated when the
content runtime is created and can be changed by rebuilding or recreating that
runtime.

```ts
import knap from "comark-knap"

export const content = defineContent({
  plugins: [
    knap({
      variables: {
        environment: process.env.NODE_ENV,
      },
    }),
  ],
  source: fs("./docs"),
})
```

Use per-render Markdown APIs when plugin values must come from an individual
request or invocation. Content parsing and cache refreshes use the plugin list
configured on the content runtime.

Use `contentSource(input, { prefix, schema })` to configure a Source. Adapted Sources retain one reader per asynchronous load, including overlapping refreshes. `defineContentHandler()` adapts the Comark Web handler to H3 events.

## Document collections

`collections` stores Markdown documents in a Workspace with retained history, such as the Blob + Database Store. `fields` is a record of Standard Schema validators, one per frontmatter field, so validators from different libraries mix. Wrap a validator without `.optional()` in `optional()`.

```ts
import { defineContent, documents } from "@vite-hub/content"
import { z } from "zod"

export const content = defineContent({
  workspace: "site",
  collections: {
    posts: documents({
      path: "posts/**/*.md",
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
  },
  authorize: ({ user, action }) => user?.role === "editor" || action === "read",
})

const posts = content.collection("posts")
const saved = await posts.save("hello", { data: { title: "Hello", date: "2026-10-14" }, body: "# Hello" }, { ifDigest: null })
await posts.list({ ref: "draft", filter: { tags: "vue" }, sort: { field: "date", direction: "desc" } })
await posts.status("hello") // { state: "draft", draft: saved.digest, published: null }
await content.publish({ collection: "posts", ids: ["hello"] })
await content.revisions("posts", "hello")
```

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve `published`, except to a request with a valid preview cookie. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can()` first.

## Draft preview

`content.preview.enable(event)` signs an HMAC token with `VITEHUB_CONTENT_KEY` (32 random bytes as base64 or hex) and sets it as an `HttpOnly`, `SameSite=Strict` cookie for one hour by default. A request with a valid cookie reads `draft` through `/api/content/**`, `content.get()`/`list()`/`navigation()`/`search()`, and collection `get()`/`list()`, and gets `Cache-Control: private, no-store`. The grant lives in `AsyncLocalStorage` for that request only.

```ts
if (!await content.can({ user, collection: "posts", action: "read" })) throw createError({ statusCode: 403 })
await content.preview.enable(event, { maxAge: 900 })
content.preview.disable(event)
await content.preview.run(event, () => content.collection("posts").get("hello")) // where no middleware scopes the request
```

ViteHub generates `defineContentPreviewMiddleware()` for Nitro 3 apps, so pages and server routes read drafts without changes. Without the key, preview works only when `NODE_ENV` is `development` or `test`; elsewhere `enable()` throws `CONTENT_R0010` and cookies are ignored.
