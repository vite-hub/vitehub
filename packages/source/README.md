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
import { defineSources, file, github, glob, registerSources, useSource } from "@vite-hub/source"

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

Keep binary assets behind the Blob boundary and store a serializable reference in
the record. This keeps ordinary record reads lazy while treating the structured
data and its assets as one logical item.

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
