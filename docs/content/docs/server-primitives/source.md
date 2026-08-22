---
title: Source
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 8
icon: i-lucide-folder-input
---

Use Source when server code needs read-only content from files, globs, Markdown, GitHub, MCP resources, or a custom loader.

Source retrieves content but doesn't place it in a persistent file tree. Bind a Source to [Workspace](/docs/server-primitives/workspace) when the content needs paths, sync, snapshots, rules, or agent access.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub
```

### Configure

```ts [server/sources.ts]
import { defineSources, registerSources } from 'vite-hub/source'
import { file } from 'vite-hub/source/file'

export const sources = defineSources({
  readme: file('README.md'),
})

registerSources(sources)
```

### Start using it

```ts [server/api/readme.get.ts]
import '../sources'
import { useSource } from 'vite-hub/source'

export default defineEventHandler(() => {
  return useSource('readme').read('README.md')
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSource`, `defineSources`, `createSource`, `combineSources`, `custom` from `vite-hub/source` | Define Sources, create context-dependent readers, and combine keyed readers. |
| `defineCollection`, `table` from `vite-hub/source`, `useCollection` from `vite-hub/source/client` | Turn a table or custom loader into a typed, paginated HTTP read model and consume it from Vue. |
| `useDatabase` from `vite-hub/database/drizzle` | Access a discovered database and its generated schema. |
| `registerSource`, `registerSources`, `clearSources`, `getRegisteredSource`, `useSource` from `vite-hub/source` | Manage and read the process-local Source registry. |
| `file`, `glob`, `github`, `markdown`, `mcpResources` from the matching `vite-hub/source/*` subpath | Select one built-in loader and its private implementation closure. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Inspect registry, path, and loader failures by `SOURCE_*` code. |

Source, Source Reader, Source Item, cache, search, and error types are exported from `vite-hub/source`. Loader option types live beside their implementation subpath. Libraries that install the package directly can use the matching `@vite-hub/source` paths.

## Register Sources

Use `vite-hub/source` when you want a direct retrieval registry.

```ts [server/sources.ts]
import { defineSources, registerSources } from 'vite-hub/source'
import { file } from 'vite-hub/source/file'
import { github } from 'vite-hub/source/github'

export const sources = defineSources({
  readme: file('README.md'),
  docs: github({
    repo: 'acme/docs',
    ref: 'main',
    root: 'docs',
    include: ['**/*.md'],
  }),
})

registerSources(sources)
```

Named Source Loader imports are the public authoring shape. Import the helpers you need directly.

Source has no discovery or Vite Integration by itself. Import the module that registers Sources before calling `useSource()` in a process.

## Source loader options

| Loader | Key options | Nuance |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source Context root. `workspacePath` controls the Source key. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Uses the `file()` contract with `text/markdown` as the default media type. Unlike `file()`, it requires an options object. |
| `glob(options)` | `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Expands local files with `tinyglobby`; `keyCache: false` refreshes keys on each read path. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `exclude`, `cache`. | Retrieves repository archive content. `auth` can be a token string or a trusted callback. |
| `mcpResources(options)` | `server`, `include`, `exclude`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` can be a client, client config, or resolver. |
| `custom(source)` | A `Source` object. | Use when the built-in loaders do not match the origin contract. |

### Cache options

`github()`, `mcpResources()`, and custom Sources can expose a cache policy; `false` disables it. GitHub applies the policy to its own ref, archive, and metadata caches. Workspace can also consume the same policy when it decides whether materialized Source content is fresh.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses this value when deciding whether materialized Source content is still fresh. |

## Source object contract

A custom `Source` implements the retrieval behavior directly.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Loader name used in errors and metadata. |
| `cache` | `false or SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for origin state. |
| `prepare(ctx)` | `function` | Optional prefetch or validation hook. |
| `getKeys(ctx)` | `function` | Returns all addressable Source keys. |
| `getItem(key, ctx)` | `function` | Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional bulk item reader. |
| `getMeta(key, ctx)` | `function` | Optional metadata reader. |
| `search(query, ctx)` | `function` | Optional Source search implementation. |
| `watch` | `unknown[]` | Optional watch descriptors for the consuming integration. Source does not start a watcher by itself. |

`getKeys()` and `getItem()` are required. `prepare()` runs at most once for each `useSource()` reader before its first operation. `getItems()` lets a consumer load all items in one call; `getMeta()` can return origin metadata without loading content.

### Source context

The caller supplies `SourceContext` to every custom Source method.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` for `useSource()` | Base project directory. |
| `sourceRootDir` | `string` | None | Optional Source-specific root. Built-in local file loaders fall back to `rootDir` when it is absent. |
| `source` | `string` | Registered Source name | Identifies the active Source. |
| `workspace` | `string` | None | Identifies the Workspace consuming the Source. |
| `abortSignal` | `AbortSignal` | None | Cancels in-flight work. Custom loaders must forward it to fetches and other abortable operations. |

### Custom search

A custom `search(query, ctx)` returns `SourceSearchHit[]`. Workspace can call this hook when it searches Source-backed paths; `SourceReader` itself exposes keys, item reads, metadata, existence checks, and listing.

| Query field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Text or regular-expression pattern to find. |
| `cwd` | `string` | No | Narrows search to a Source-relative directory. |
| `paths` | `string[]` | No | Restricts search to explicit Source paths. |
| `regex` | `boolean` | No | Interprets `pattern` as a regular expression. |
| `caseSensitive` | `boolean` | No | Enables case-sensitive matching. |
| `limit` | `number` | No | Caps the number of returned hits. |

| Result field | Type | Description |
| --- | --- | --- |
| `path` | `string` | Source-relative path containing the match. |
| `line` | `number` | Match line number. |
| `column` | `number` | Match column number. |
| `text` | `string` | Matching line or excerpt. |

## Use it at runtime

Read a Source by name with `useSource()`.

```ts [server/api/readme.get.ts]
import '../sources'
import { useSource } from 'vite-hub/source'

export default defineEventHandler(async () => {
  const readme = useSource('readme')

  return {
    text: await readme.read('README.md'),
  }
})
```

## Source reader API

| Method | Returns |
| --- | --- |
| `source.keys()` | All Source keys. |
| `source.get(key)` | A `SourceItem` with content, data, media type, and metadata. |
| `source.read(key, options?)` | Text by default, or `Uint8Array` with `{ encoding: 'binary' }`. |
| `source.meta(key)` | Metadata for one key, when the loader supports it. |
| `source.exists(key)` | Whether a key exists. |
| `source.list(prefix?)` | Direct child files and directories below a prefix. |

```ts [server/api/docs.get.ts]
import '../sources'
import { useSource } from 'vite-hub/source'

export default defineEventHandler(async () => {
  const docs = useSource('docs')

  return {
    files: await docs.keys(),
    root: await docs.list(''),
  }
})
```

## Combine keyed Source readers

Use `combineSources()` when several readers can return the same key. A
combined reader identifies each item with a `[source, key]` tuple, so the source
alias remains part of the runtime value and its inferred type.

```ts [server/recaps.ts]
import { combineSources, createSource, defineSource } from 'vite-hub/source'

const github = defineSource(context => ({
  async get(month: `${number}-${number}`) {
    return { month, rootDir: context.rootDir }
  },
  async items() {
    return [{ key: '2026-07' as const }]
  },
}))

export const recaps = combineSources({
  sources: {
    github: createSource(github, { rootDir: process.cwd() }),
  },
})

await recaps.get(['github', '2026-07'])
await recaps.items()
// [{ key: '2026-07', source: 'github', identity: ['github', '2026-07'] }]
```

Source aliases must be strings. `get()` infers the accepted key and result
for each alias. `items()` is available on every combined reader, but it rejects a
partially enumerable reader before starting any work. When every reader
implements `items()`, each returned item includes `source` and `identity`.

`defineSource(context => reader)` declares a context-dependent keyed reader.
`createSource()` creates that reader with a `SourceContext`. Combined readers do not
change the process-local registry: `defineSources()`, `registerSources()`, and
`useSource()` keep their existing behavior.

## Expose a typed Collection

A Source describes where data comes from. A Collection describes the paginated
object shape an application exposes to a client. For a discovered Drizzle
database, let the database adapter own the keyset query:

```ts [server/collections/articles.ts]
import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import { useDatabase } from 'vite-hub/database/drizzle'
import { defineCollection, table } from 'vite-hub/source'

const { db, schema } = useDatabase('default')

export const articles = defineCollection({
  source: table({
    db,
    table: schema.articles,
    orderBy: {
      column: schema.articles.createdAt,
      direction: 'desc',
      tieBreaker: schema.articles.id,
    },
    defaultLimit: 25,
    maxLimit: 100,
    querySchema: v.object({ author: v.optional(v.string()) }),
    where: ({ query, table }) => query.author
      ? eq(table.author, query.author)
      : undefined,
  }),
  transform: article => ({ id: article.id, title: article.title }),
})
```

`column` and `tieBreaker` must be non-null columns on the selected table, and the
tie-breaker must be unique. The table source applies `where` before its lexicographic
cursor predicate, orders both columns consistently, requests the extra row, and
keeps the cursor opaque to clients. Omit `querySchema` and `where` when the
Collection has no filters.

Use `defineCollection` directly when the origin is a Source reader, SDK, HTTP
API, joined query, or another loader whose pagination is not a single Drizzle
table. In that escape hatch, the loader owns its origin-specific cursor logic.

```ts [server/collections/articles.ts]
import { defineCollection } from 'vite-hub/source'
import * as v from 'valibot'

export const articles = defineCollection(async ({ cursor, limit, query }) => {
  return db.listArticles({ after: cursor, author: query.author, limit })
}, {
  cursor: article => [article.createdAt, article.id] as const,
  cursorSchema: v.tuple([v.number(), v.string()]),
  defaultLimit: 25,
  maxLimit: 100,
  querySchema: v.object({ author: v.optional(v.string()) }),
  transform: article => ({ id: article.id, title: article.title }),
})
```

The generic Collection requests one extra row from the loader, enforces its configured
limits, and turns the last visible row into an opaque cursor. `transform()` is
the server-to-client boundary, so private columns and provider objects stay out
of the response while its return type becomes the client item type. Any Standard
Schema validator can provide `cursorSchema` and `querySchema`; their output types
flow into the loader without manual generic annotations.

```vue [app/pages/articles.vue]
<script setup lang="ts">
const author = ref<string>()
const { items, pending, error, hasMore, loadMore } = useCollection('articles', {
  filter: computed(() => ({ author: author.value })),
})
</script>
```

ViteHub discovers named exports in `server/collections`, generates their name,
type registry, and read-only GET route, and maps `articles` to `/api/articles`. The Nuxt module
auto-imports `useCollection`; outside Nuxt, import it from
`vite-hub/source/client`. Everything in `server/collections` is public through
its transformed shape; keep private definitions elsewhere and do not create a
matching `server/api` handler. Use `filter` for validated request input. It stays
fixed while `loadMore()` advances the opaque cursor. For a bounded Collection,
set `all: true` to fetch every page asynchronously. `cursor` and `limit` are
reserved route query parameters. Invalid limits, cursor encodings, and parsed
filters return HTTP 400.

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content needs to appear inside a persistent Workspace file tree.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, file, github } from 'vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: file('README.md'),
    docs: github({
      repo: 'acme/docs',
      root: 'docs',
      mount: 'docs',
      materialize: 'lazy',
    }),
  },
})
```

The same loader names appear in both packages. Import them from `vite-hub/source/*` for direct retrieval through `useSource()`. Import them from `vite-hub/workspace` when retrieved items need Workspace paths, materialization, sync, validation, resolution, or access rules.

## Provider output

Source has no Vite integration. By itself, it doesn't generate host output, provider config, or discovered Definitions.

Workspace and other consuming packages can wrap Sources in discovered Definitions, runtime registries, generated metadata, or Provider Output when they need placement, persistence, or deployment wiring.

## Production checks

Sources are read-only. Read secrets for private origins from Server Env or trusted callbacks, not from model-authored input.

Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped agent visibility. Use Source directly when server code only needs to retrieve and inspect items.

## Next steps

- Learn the shared model in [Workspace and Sources](/docs/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/server-primitives/workspace).
- Expose visible Workspace content to agents through [Official capabilities](/docs/capabilities/official-capabilities).
