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
import cms from "@vite-hub/content/presets/cms"
import { z } from "zod"

export const content = defineContent({
  extends: cms,
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

`extends: cms` stores the collections without wiring. At build time `hubContent()` from `@vite-hub/content/vite` (included in `vitehub()`) reads the preset from `server/content.ts`, contributes a `content` Workspace on the Blob + Database Store, and adds `workspaceHistorySchema` to the default or only Database. Pass `[cms, { database, blob, workspace }]` with string literals to choose others. Workspace, Database, and Blob must be enabled; the build fails with `CONTENT_B0002` and names the setting otherwise. Without the preset, pass `workspace` with the name of a Workspace you define.

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve only `published`. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can()` first.
