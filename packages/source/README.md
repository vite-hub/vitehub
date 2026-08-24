# @vite-hub/source

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Sources" src="https://img.shields.io/badge/Source-typed%20retrieval-0f766e?style=flat-square">
</p>

`@vite-hub/source` loads files, globs, markdown, GitHub content, or custom data before something else places it in a workspace.

## Install

```sh
pnpm add @vite-hub/source
```

## Minimal API

```ts
// server/utils/sources.ts
import { defineSources, registerSources, useSource } from "@vite-hub/source"
import { file } from "@vite-hub/source/file"
import { github } from "@vite-hub/source/github"
import { glob } from "@vite-hub/source/glob"

registerSources(defineSources({
  docs: glob({ include: "docs/**/*.md" }),
  readme: file("README.md"),
  upstream: github({ repo: "vite-hub/vitehub" }),
}))

const docs = useSource("docs", { rootDir: process.cwd() })
const revision = await docs.revision()
const keys = await docs.keys()
const first = await docs.read(keys[0]!)
```

`revision()` resolves an origin snapshot once per reader. Revision-aware loaders
then use the same immutable identity for preparation, keys, and item reads.

## Runtime content with Comark Content

Source owns origin retrieval. [Comark Content](https://docs-template.comark.dev/concepts/architecture)
can own the derived content system: Markdown parsing, manifests, navigation,
cache artifacts, runtime HTTP handling, SQL queries, and ranked full-text
search. Adapt any registered ViteHub Source instead of recreating those
features in its loader:

```sh
pnpm add @vite-hub/source comark-content
```

```ts
import sqlite from "comark-content/database/sqlite-node"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { defineContent } from "@vite-hub/source/content"

export const content = defineContent({
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: "docs",
  },
})

await content.get("/guide")
await content.navigation(["docs"])
await content.search(["docs"], "runtime")

```

With ViteHub's Vite or Nuxt integration, `server/content.ts` is discovered and
served at `/api/content/**`; no framework route is required. `defineContent()`
returns the Comark Content instance, including methods contributed by its query,
search, references, and custom plugins. Each Comark cache refresh gets a new
ViteHub Source Reader and origin revision, while every individual load remains
pinned to one revision.

Use `sqlite-wasm` instead of `sqlite-node` on runtimes without Node's SQLite
module. Comark's cache accepts an unstorage driver and exposes
`refresh(source)`, `invalidate(key)`, and `expire(key)`, so applications do not
need a second parsed-content cache in ViteHub.

Use Comark's native Sources directly when ViteHub retrieval is unnecessary:

```ts
import fs from "comark-content/sources/fs"
import { defineContent } from "@vite-hub/source/content"

export const content = defineContent({
  sources: {
    assets: fs(".data/assets", { prefix: "public" }),
  },
})
```

On the client, use `createContentClient` from
`@vite-hub/source/content/client`. Add Comark's SQL-query or full-text-search
client plugin to call the same plugin methods over the generated endpoint.

Workspace search remains filesystem search over the visible Workspace tree.
Comark search is semantic content search over parsed documents. They deliberately
have different owners and result contracts.

Structured sources preserve record and metadata types through `useSource()`:

```ts
import type { Source } from "@vite-hub/source"

interface Article {
  author: string
  cover: { key: string, mediaType: string }
  title: string
}

interface ArticleMetadata {
  revision: string
}

declare global {
  interface ViteHubSourceMap {
    articles: Source<`article_${string}`, Article, ArticleMetadata>
  }
}

const article = await useSource("articles").get("article_123")
article.data?.title
article.metadata?.revision

const articles = await useSource("articles").items()
```

Combine runtime Source readers when keys can overlap:

```ts
import { combineSources, defineSource } from "@vite-hub/source"

const recaps = combineSources({
  sources: {
    github: defineSource({
      get: async (month: `${number}-${number}`) => ({ month }),
      items: async () => [{ key: "2026-07" as const }],
    }),
  },
})

await recaps.get(["github", "2026-07"])
await recaps.items() // [{ key: "2026-07", source: "github", identity: ["github", "2026-07"] }]
```

Define a Collection when a database or other origin should become a typed,
paginated client read model:

```ts
// server/collections/articles.ts
import { defineCollection } from "@vite-hub/source"
import * as v from "valibot"

export const articles = defineCollection(async ({ cursor, limit, query }) => {
  return db.listArticles({ after: cursor, author: query.author, limit })
}, {
  cursor: article => [article.createdAt, article.id] as const,
  cursorSchema: v.tuple([v.number(), v.string()]),
  querySchema: v.object({ author: v.optional(v.string()) }),
  transform: article => ({ id: article.id, title: article.title }),
})
```

`cursorSchema` and `querySchema` accept any Standard Schema validator. Their
output types flow into the loader, so the loader needs no manual generic types.

```ts
// app/composables/articles.ts
import { useCollection } from "@vite-hub/source/client"

export const useArticles = () => useCollection("articles", {
  all: true,
  filter: { author: "Ada" },
})
```

ViteHub discovers modules in `server/collections` and generates the collection
registry and GET handler. The module must export a Collection with the same name
as its filename, so `articles.ts` exports `articles` and maps to `/api/articles`.
Everything in that directory is a public read model; keep private definitions
elsewhere and do not repeat the route under `server/api`. Restart Nuxt after
adding, removing, or renaming a Collection module so Nitro rebuilds its handler
manifest.
Callers do not repeat URL strings or generic imports. `filter` is validated by
the Collection's query schema before the loader runs and remains fixed across
cursor pages. Set `all: true` for bounded Collections that should materialize
every page; otherwise call `loadMore()` explicitly. The loader owns the
origin-specific query. Collection owns limit enforcement, opaque cursor
transport, response shaping, and the exact item and filter types consumed by
`useCollection()`.

Keep binary assets behind the Blob boundary and store a serializable reference in
the record. This keeps ordinary record reads lazy while treating the structured
data and its assets as one logical item.

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
