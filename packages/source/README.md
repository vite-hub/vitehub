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
const keys = await docs.keys()
const first = await docs.read(keys[0]!)
```

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

import type { CollectionLoadOptions } from "@vite-hub/source"

export const articles = defineCollection(async ({ cursor, limit, query }: CollectionLoadOptions<
  { author?: string },
  readonly [createdAt: number, id: string]
>) => {
  return db.listArticles({ after: cursor, author: query.author, limit })
}, {
  cursor: article => [article.createdAt, article.id] as const,
  parseCursor(input) {
    if (!Array.isArray(input) || input.length !== 2
      || typeof input[0] !== "number" || typeof input[1] !== "string") {
      throw new TypeError("Article cursor must contain a timestamp and id.")
    }
    return [input[0], input[1]] as const
  },
  query(input): { author?: string } {
    return typeof input.author === "string" ? { author: input.author } : {}
  },
  transform: article => ({ id: article.id, title: article.title }),
})
```

```ts
// server/api/articles.get.ts
import { defineCollectionHandler } from "@vite-hub/source/server"
import { articles } from "../collections/articles"

export default defineCollectionHandler(articles)
```

```ts
// app/composables/articles.ts
import { useCollection } from "@vite-hub/source/client"

import type { articles } from "../../server/collections/articles"

export const useArticles = () => useCollection<typeof articles>("/api/articles", {
  query: { author: "Ada" },
})
```

The loader owns the origin-specific query. Collection owns limit enforcement,
opaque cursor transport, response shaping, and the exact item and query types
consumed by `useCollection()`.

Keep binary assets behind the Blob boundary and store a serializable reference in
the record. This keeps ordinary record reads lazy while treating the structured
data and its assets as one logical item.

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
