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
  authorize: ({ user, actor, action }) => user?.role === "editor" && (actor === undefined || action !== "publish"),
})

const posts = content.collection("posts")
const saved = await posts.save("hello", { data: { title: "Hello", date: "2026-10-14" }, body: "# Hello" }, { ifDigest: null })
await posts.list({ ref: "draft", filter: { tags: "vue" }, sort: { field: "date", direction: "desc" } })
await posts.status("hello") // { collection: "posts", id: "hello", state: "draft", draft: saved.digest, published: null }
await posts.raw("hello", { ref: "draft" }) // the stored file, even if it no longer validates
await content.publish({ expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
await content.revisions("posts", "hello")
content.collections() // [posts], each with name, kind, format, path, fields, and schema
```

`singleton({ path, fields })` defines one document at a fixed path, such as site settings. Its methods take no id, and `publish({ expect })` entries for it may omit `id`. The extension sets the format of a document or collection: `.json` stores an indented JSON object, `.yaml`/`.yml` a block-style YAML mapping, and anything else Markdown with YAML frontmatter. JSON and YAML documents have no body.

```ts
import { defineContent, documents, singleton } from "@vite-hub/content"

export const content = defineContent({
  workspace: "site",
  collections: {
    settings: singleton({ path: "settings.json", fields: { title: z.string(), social: z.array(z.url()).default([]) } }),
    authors: documents({ path: "authors/*.yaml", fields: { name: z.string() } }),
  },
})

const settings = content.collection("settings") // kind: "singleton", id: "settings"
const draft = await settings.save({ data: { title: "ViteHub" } })
await content.publish({ expect: [{ collection: "settings", digest: draft.digest }] })
await settings.get() // the published settings, also at /api/content/get/settings
```

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve only `published`. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. `publish({ expect })` publishes exactly the reviewed draft digests and throws `WORKSPACE_CONFLICT` when one changed, so confirm and approve flows use it. Listed documents carry `updatedAt`, when each last changed on the ref read. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can({ user, actor })` first, where `user` is the Auth user and `actor` is the Agent Actor, if any. Zod date fields project to `date-time` strings in `schema`; wrap Valibot fields in `toStandardJsonSchema()`, and Content warns once for each field whose JSON Schema is empty.

## SEO

`documents({ url: "/blog/:id" })` maps documents to public URLs, and reads carry `document.url`. `seo()` is a field for per-document `{ title, description, image, canonical, noindex }`; pass `seo({ image: image() })` to store a Blob reference. `contentHead(document, { site, defaults })`, also exported from `@vite-hub/content/client`, returns unhead-shaped `{ title, meta, link, script? }` that merge the `seo()` values, the document fields, and site defaults. `defineContent({ seo: { site, sitemap: true, robots: true } })` makes ViteHub generate `/sitemap.xml` and `/robots.txt`; `content.sitemap()` and `content.robots()` return the same output.

```ts
useHead(contentHead(post, { site: { url: "https://vitehub.dev", name: "ViteHub" }, defaults: { description: settings.data.description } }))
```
