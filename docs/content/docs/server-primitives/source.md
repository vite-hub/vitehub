---
title: Source
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 8
navigation.group: Files and execution
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

### Define a Source

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

### Open a reader

```ts [server/api/docs.get.ts]
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

`createSource(definition, context?)` opens a reader directly. It infers keys,
items, and metadata from the definition. No registry or global type map is needed.
Reuse the same definition in Content or a Workspace Source Binding.

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSource`, `defineSources`, `createSource`, `combineSources` from `vite-hub/source` | Define loaders, open managed readers, and combine keyed readers. |
| `defineCollection`, `table` from `vite-hub/source`, `useCollection` from `vite-hub/source/client` | Turn a table or custom loader into a typed, paginated HTTP read model and consume it from Vue. |
| `useDatabase` from `vite-hub/database/drizzle` | Access a discovered database and its generated schema. |
| `registerSource`, `registerSources`, `clearSources`, `getRegisteredSource`, `useSource` from `vite-hub/source` | Manage and read the process-local Source registry. |
| `file`, `glob`, `github`, `markdown`, `mcpResources` from the matching `vite-hub/source/*` subpath | Select one built-in loader and its private implementation closure. |
| `cachedSource` from `vite-hub/source/server` | Cache an existing keyed reader with Nitro cache options. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Inspect registry, path, and loader failures by `SOURCE_*` code. |

Source, Source Reader, Source Item, revision, cache, and error types are exported from `vite-hub/source`. Loader option types live beside their implementation subpath. Libraries that install the package directly can use the matching `@vite-hub/source` paths.

## Register Sources

Register Sources only when callers need lookup by name. Direct `createSource()` calls do not need registration.

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

declare global {
  interface ViteHubSourceMap {
    readme: typeof sources.readme
    docs: typeof sources.docs
  }
}
```

Named Source Loader imports are the public authoring shape. Import the helpers you need directly.

Import the module that registers Sources before calling `useSource()` in a process. For typed name lookup, declare `ViteHubSourceMap` entries as `typeof` the matching definitions. The Vite integration generates Collection types and routes, but does not generate this named Source map.

`RegisteredSource<'docs'>` resolves a registered name to its definition type.

## Source loader options

| Loader | Key options | Nuance |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source Context root. `workspacePath` controls the Source key. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Uses the `file()` contract with `text/markdown` as the default media type. Unlike `file()`, it requires an options object. |
| `glob(options)` | `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Expands local files with `tinyglobby`; `keyCache: false` disables the cached key snapshot. Symbolic links are off by default. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `ignore`, `cache`. | Retrieves repository archive content. `auth` can be a token string or a trusted callback. |
| `mcpResources(options)` | `server`, `include`, `ignore`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` can be a client, client config, or resolver. |
| `defineSource(loader)` | A loader with `name`, `getKeys`, and `getItem`. | Define custom retrieval behavior with inferred item types. |

Use `sourceIgnores` from `vite-hub/source` for reusable dependency, generated-output, media, secret, and system-file patterns. Workspace GitHub Sources apply `sourceIgnores.defaults` automatically; pass `ignore: false` to opt out or provide more patterns to extend the defaults.

`file()` follows a symbolic link only when its resolved target stays inside the Source root. `glob()` is also confined to the Source root. By default, it rejects an item when its file or a parent directory is a symbolic link. Set `followSymlinks: true` to follow links when their resolved targets stay inside the Source root. This option controls which local files the Source can select. It does not isolate the process from concurrent file system changes.

### Cache options

`github()`, `mcpResources()`, and custom Sources can expose a cache policy; `false` disables it. GitHub applies the policy to its own ref, archive, and metadata caches. Workspace can also consume the same policy when it decides whether materialized Source content is fresh.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses this value when deciding whether materialized Source content is still fresh. |

## Source object contract

`defineSource()` accepts a loader definition. Every loader has `name`,
`getKeys()`, and `getItem()`. It does not accept reader objects or reader factories.

```ts
import { createSource, defineSource } from 'vite-hub/source'

const articles = defineSource({
  name: 'articles',
  async getKeys() {
    return ['article_123' as const]
  },
  async getItem(key: `article_${string}`) {
    return { key, data: { title: 'Source API' }, metadata: { version: 1 } }
  },
})

const reader = createSource(articles)
const article = await reader.get('article_123')
article.data.title
article.metadata.version
```

`SourceReader<typeof articles>`, `SourceKey<typeof articles>`,
`SourceData<typeof articles>`, and `SourceMetadata<typeof articles>` derive their
types from the definition. A record reader has no typed `read()` or `list()`
methods. File loaders return `FileSource`, whose `SourceFile` items always have
`content`. Custom loaders that guarantee `content` receive these file methods too.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Loader name used in errors and metadata. |
| `cache` | `false or SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for origin state. |
| `resolveRevision(ctx)` | `function` | Optionally pins a mutable origin ref to one revision before any other operation. |
| `prepare(ctx)` | `function` | Optional prefetch or validation hook. |
| `getKeys(ctx)` | `function` | Returns all addressable Source keys. |
| `getItem(key, ctx)` | `function` | Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional bulk item reader. |
| `getMeta(key, ctx)` | `function` | Optional metadata reader. |

`getKeys()` and `getItem()` are required. `resolveRevision()` and `prepare()` each run at most once for every `createSource()` or `useSource()` reader before its first operation. The resolved revision is added to the shared context. Revision-aware loaders use it for preparation, keys, items, and metadata. Loaders without revision support can observe origin changes. `getItems()` lets a consumer load all items in one call; `getMeta()` can return origin metadata without loading content.

### Source context

`createSource()` accepts a partial context and supplies the full `SourceContext` to each loader method. `useSource(name, context?)` uses the same reader lifecycle.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Base project directory. |
| `sourceRootDir` | `string` | None | Optional Source-specific root. Built-in local file loaders fall back to `rootDir` when it is absent. |
| `source` | `string` | Definition name, or registered name for `useSource()` | Identifies the active Source. |
| `workspace` | `string` | None | Identifies the Workspace consuming the Source. |
| `abortSignal` | `AbortSignal` | None | Cancels in-flight work. Custom loaders must forward it to fetches and other abortable operations. |
| `revision` | `SourceRevision` | None | The revision pinned by `resolveRevision()` for every later operation in this reader or Workspace lifecycle. |

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
| `source.revision()` | The pinned origin revision, when supported. |
| `source.keys()` | All Source keys. |
| `source.get(key)` | The loader's inferred item. Items can hold content, structured data, or both. |
| `source.items()` | All items, using `getItems()` when supplied, otherwise `getKeys()` and `getItem()`. |
| `source.read(key, options?)` | File readers only. Text by default, or `Uint8Array` with `{ encoding: 'binary' }`. |
| `source.meta(key)` | Metadata for one key, when the loader supports it. |
| `source.exists(key)` | Whether a key exists. |
| `source.list(prefix?)` | File readers only. Direct child files and directories below a prefix. |

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

## Parse and serve content

Use [Content](/docs/server-primitives/content) when Source output should become parsed documents, navigation, queries, or full-text search. Pass the definition directly:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { docs } from './sources/docs'

export const content = defineContent({ source: docs })
```

Content opens a new reader for each refresh. Each load keeps its own revision,
including when refreshes overlap. Pass a definition when Content should own that
lifecycle. An explicitly supplied reader retains its caller-owned lifecycle.

## Combine keyed Source readers

Use `combineSources()` when several readers can return the same key. A
combined reader identifies each item with a `[source, key]` tuple, so the source
alias remains part of the runtime value and its inferred type.

```ts [server/recaps.ts]
import { combineSources } from 'vite-hub/source'

function githubRecaps(rootDir: string) {
  return {
    async get(month: `${number}-${number}`) {
      return { month, rootDir }
    },
    async items() {
      return [{ key: '2026-07' as const }]
    },
  }
}

export const recaps = combineSources({
  sources: { github: githubRecaps(process.cwd()) },
})

await recaps.get(['github', '2026-07'])
await recaps.items()
// [{ key: '2026-07', source: 'github', identity: ['github', '2026-07'] }]
```

Source aliases must be strings. `get()` infers the accepted key and result for
each alias. `items()` exists only when every input reader implements it. Each
listed item includes `source` and `identity`.

Use ordinary objects or functions for custom keyed readers. Use `defineSource()`
for loaders that need the managed revision and preparation lifecycle.

### Cache a reader

```ts
import { cachedSource } from 'vite-hub/source/server'

const cachedRecaps = cachedSource(githubRecaps(process.cwd()), {
  name: 'recaps',
  maxAge: 60,
})

await cachedRecaps.get('2026-07')
```

`cachedSource(reader, options)` accepts an existing keyed reader and Nitro cache
options. Cache ordinary readers before passing them to `combineSources()`.
Give each cache a name that identifies its origin and access scope.
Do not share one cache name across callers who can see different data.

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

ViteHub discovers modules in `server/collections` and generates their type
registry and read-only GET routes. Each module exports a Collection with the
same name as its filename, so `articles.ts` exports `articles` and maps to
`/api/articles`. The Nuxt module auto-imports `useCollection`; outside Nuxt,
import it from `vite-hub/source/client`. Everything in `server/collections` is
public through its transformed shape; keep private definitions elsewhere and do
not create a matching `server/api` handler. Restart Nuxt after adding, removing,
or renaming a Collection module so Nitro rebuilds its handler manifest. Use
`filter` for validated request input. It stays
fixed while `loadMore()` advances the opaque cursor. For a bounded Collection,
set `all: true` to fetch every page asynchronously. `cursor` and `limit` are
reserved route query parameters. Invalid limits, cursor encodings, and parsed
filters return HTTP 400.

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content needs to appear inside a persistent Workspace file tree.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'
import { docs } from '../sources/docs'

export default defineWorkspace({
  sources: {
    docs: {
      source: docs,
      mount: 'docs',
      materialize: 'lazy',
    },
  },
})
```

Workspace owns placement, materialization, sync, and access rules. The Source
still owns retrieval. The binding above reuses the same definition as direct
reads and Content. The key `intro.md` appears at `docs/intro.md` in the Workspace.

Workspace also exports helpers such as `file()` and `github()` that combine
loader options with Workspace binding options.

## Framework output

`hubSource()` from `vite-hub/source/vite` discovers Collections and Content. It
generates Collection type declarations and GET routes, plus the Content route.
The Nuxt integration installs this behavior for Nuxt applications.

Direct Source definitions and their optional process-local registry do not need
Vite. The integration does not discover a `server/sources` directory or generate
`ViteHubSourceMap`. Workspace owns its own discovered definitions and provider
output.

## Production checks

Sources are read-only. Read secrets for private origins from Server Env or trusted callbacks, not from model-authored input.

Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped agent visibility. Use Source directly when server code only needs to retrieve and inspect items.

## Next steps

- Learn the shared model in [Workspace and Sources](/docs/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/server-primitives/workspace).
- Expose visible Workspace content to agents through [Official capabilities](/docs/capabilities/official-capabilities).
