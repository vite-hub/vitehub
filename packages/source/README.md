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

## Open a Source

```ts
import { createSource } from "@vite-hub/source"
import { glob } from "@vite-hub/source/glob"

export const docs = glob({ cwd: "docs", include: "**/*.md" })

const reader = createSource(docs, { rootDir: process.cwd() })
const revision = await reader.revision()
const keys = await reader.keys()
const first = await reader.read(keys[0]!)
```

`createSource(definition, context?)` infers keys, items, and metadata from the
Source definition. It resolves a revision and prepares the Source once per
reader. Revision-aware loaders receive the same pinned revision on every
operation. Loaders without revision support can observe origin changes. Create
another reader to resolve a new revision. No registration or global type map is needed.

`file()` follows a symbolic link only when its resolved target stays inside the Source root. `glob()` is also confined to the Source root. It does not follow symbolic links by default, and it checks each file path again before it reads content or metadata. Set `followSymlinks: true` to follow links when their resolved targets stay inside the Source root. This option controls file selection. It does not isolate the process from concurrent file system changes.

Use `defineSource()` for custom loaders:

```ts
import { createSource, defineSource } from "@vite-hub/source"

const articles = defineSource({
  name: "articles",
  async getKeys() {
    return ["article_123" as const]
  },
  async getItem(key: `article_${string}`) {
    return { key, data: { title: "Source API" }, metadata: { version: 1 } }
  },
})

const article = await createSource(articles).get("article_123")
article.data.title
article.metadata.version
```

Every loader has `name`, `getKeys()`, and `getItem()`. Optional hooks include
`resolveRevision()`, `prepare()`, `getItems()`, and `getMeta()`.
`SourceReader<typeof articles>`, `SourceKey<typeof articles>`,
`SourceData<typeof articles>`, and `SourceMetadata<typeof articles>` use the
definition type.

All managed readers expose `revision()`, `keys()`, `get()`, `items()`, `meta()`,
and `exists()`. File readers also expose `read()` and `list()`. Built-in `file`,
`glob`, `github`, `markdown`, and `mcpResources` loaders return `FileSource`.
Their `SourceFile` items guarantee `content`. Custom loaders that guarantee
content receive file methods too. Record readers use `get()` and `items()`.

## Reuse a definition

Content accepts Source definitions directly. It opens a new reader on each
refresh, so overlapping loads keep separate revisions:

```ts
import { defineContent } from "@vite-hub/content"

export const content = defineContent({ source: docs })
```

Workspace binds the same definition to a persistent file tree:

```ts
import { defineWorkspace } from "@vite-hub/workspace"

export default defineWorkspace({
  sources: {
    docs: { source: docs, mount: "docs", materialize: "lazy" },
  },
})
```

Workspace owns paths, materialization, sync, and access rules. Source owns
retrieval. Content owns parsed documents, navigation, queries, and search.

## Optional name lookup

```ts
import { defineSources, registerSources, useSource } from "@vite-hub/source"

const sources = defineSources({ docs })
registerSources(sources)

declare global {
  interface ViteHubSourceMap {
    docs: typeof docs
  }
}

await useSource("docs").read("intro.md")
```

`useSource(name, context?)` opens the same managed reader through a process-local
registry. Import the registration module before lookup. The Vite integration
for Collections and Content does not generate `ViteHubSourceMap`.

## Combine keyed readers

Use ordinary objects or functions for readers that do not need a loader
lifecycle. `combineSources()` keeps aliases in each key and result:

```ts
import { combineSources } from "@vite-hub/source"

const recaps = combineSources({
  sources: {
    github: {
      get: async (month: `${number}-${number}`) => ({ month }),
      items: async () => [{ key: "2026-07" as const }],
    },
  },
})

await recaps.get(["github", "2026-07"])
await recaps.items() // [{ key: "2026-07", source: "github", identity: ["github", "2026-07"] }]
```

A combined reader exposes `items()` only when every input implements it.

Use `cachedSource()` to add Nitro caching to a keyed reader:

```ts
import { cachedSource } from "vite-hub/source/server"

const cachedDocs = cachedSource(createSource(docs), { name: "docs", maxAge: 60 })
await cachedDocs.get("intro.md")
```

Use a different cache name for each origin and access scope. Cache ordinary
readers before passing them to `combineSources()`.

## Collections

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

## Migration

- `defineSource()` now accepts only loader definitions. Use reader objects and
  factory functions directly instead of wrapping them with `defineSource()`.
- `createSource()` now opens a loader definition. Call custom reader factories
  directly.
- Replace the Source `custom(loader)` helper with `defineSource(loader)`.
- Replace the server `defineSource({ ...reader, cache: cacheOptions })` wrapper
  with `cachedSource(reader, { name, ...cacheOptions })`.
- Change `SourceReader<"docs">` and related helper types to
  `SourceReader<typeof docs>`. `RegisteredSource<"docs">` resolves a name to its
  definition type when needed.
- File methods require items with guaranteed content. Use `FileSource` for
  explicit file loader types. Combined readers with a get-only input have no
  `items()` method.

Collections keep their existing pagination and response API. Workspace bindings
remain valid. Content can now receive the same loader definition used by
`createSource()`.

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
