---
title: Source
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 8
navigation.group: Files and execution
icon: i-lucide-folder-input
---

Use Source when server code needs read-only content from local files, globs, Markdown, GitHub, MCP resources, or a custom loader. A Source definition is a plain object. Open it with `createSource()` and read keys, items, and metadata with inferred types.

Source works without Agents and without a Vite plugin. The same definition can feed [Content](/docs/server-primitives/content), a [Workspace](/docs/server-primitives/workspace) Source Binding, or a typed Collection route.

::tip
Choose the primitive by what you do with the content:

- Source: read-only retrieval of files and records from an origin. No paths of its own, no writes.
- [Workspace](/docs/server-primitives/workspace): mutable file-tree state with paths, rules, sync, snapshots, diffs, and Agent access.
- [Content](/docs/server-primitives/content): parsed Markdown, JSON, or YAML documents with navigation, queries, and full-text search.
- Collection (on this page): a typed, paginated HTTP read model over records.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub
```

### Configure

Direct Source reads need no configuration. The `vitehub()` Vite plugin and the Nuxt module add the generated Collection and Content routes.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' })],
})
```

### Start using it

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

```ts [server/api/docs.get.ts]
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

`createSource(definition, context?)` opens a reader directly. It infers keys, items, and metadata from the definition. No registry or global type map is needed.

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSource`, `defineSources`, `createSource`, `combineSources` from `vite-hub/source` | Define loaders, open managed readers, and combine keyed readers. |
| `registerSource`, `registerSources`, `clearSources`, `getRegisteredSource`, `useSource` from `vite-hub/source` | Manage and read the process-local Source registry. |
| `sourceIgnores` from `vite-hub/source` | Reuse ignore patterns for dependencies, generated output, media, secrets, and system files. |
| `file` from `vite-hub/source/file`, `glob` from `vite-hub/source/glob`, `markdown` from `vite-hub/source/markdown`, `github` from `vite-hub/source/github`, `mcpResources` from `vite-hub/source/mcp` | Select one built-in loader. Each subpath also exports its option types. |
| `defineCollection`, `table` from `vite-hub/source` | Turn a Drizzle table or a custom loader into a typed, paginated HTTP read model. |
| `useCollection`, `CollectionAccessError` from `vite-hub/source/client` | Consume a Collection from Vue and detect access errors. |
| `cachedSource`, `defineCollectionHandler` from `vite-hub/source/server` | Cache a keyed reader with Nitro cache options, or mount a Collection handler manually. |
| `hubSource` from `vite-hub/source/vite` | Discover Collections and Content and generate their routes. `vitehub()` and the Nuxt module install it. |
| `useDatabase` from `vite-hub/database/drizzle` | Access a discovered database and its generated schema for `table()`. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Inspect registry, path, and loader failures by `SOURCE_*` code. |

Source, Source Reader, Source Item, revision, cache, and error types are exported from `vite-hub/source`. Libraries that install `@vite-hub/source` directly use the matching `@vite-hub/source/*` paths. `table()`, the object form of `defineCollection({ source })`, and `cachedSource()` exist only in the `vite-hub` distribution. `@vite-hub/source` exports only the loader form of `defineCollection()`.

## Source loader options

| Loader | Key options | Behavior |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source Context root. `workspacePath` sets the Source key. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Uses the `file()` contract with `text/markdown` as the default media type. Unlike `file()`, it requires an options object. |
| `glob(options)` | `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Expands local files with `tinyglobby`. Keys are relative to `cwd`. `prefix` prepends a path to each item. `keyCache: false` disables the cached key snapshot. Symbolic links are off by default. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `ignore`, `cache`. | Retrieves repository content. `ref` defaults to the repository default branch. `auth` can be a token string or a trusted callback. |
| `mcpResources(options)` | `server`, `include`, `ignore`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` can be a client, a client config with an `http` or `sse` transport, or a resolver. |
| `defineSource(loader)` | A loader with `name`, `getKeys`, and `getItem`. | Defines custom retrieval behavior with inferred item types. |

Use `sourceIgnores` for reusable ignore patterns. Workspace GitHub Sources apply `sourceIgnores.defaults` automatically. Pass `ignore: false` to opt out, or pass more patterns to extend the defaults.

### Cache options

`github()`, `mcpResources()`, and custom Sources can expose a cache policy. `false` disables it. GitHub applies the policy to its own ref, archive, and metadata caches. Workspace uses the same policy to decide whether materialized Source content is fresh.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses this value when it decides whether materialized Source content is still fresh. |

## Source object contract

`defineSource()` accepts a loader definition. Every loader has `name`, `getKeys()`, and `getItem()`. It does not accept reader objects or reader factories.

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

`SourceReader<typeof articles>`, `SourceKey<typeof articles>`, `SourceData<typeof articles>`, and `SourceMetadata<typeof articles>` derive their types from the definition. A record reader has no typed `read()` or `list()` methods. File loaders return `FileSource`, whose `SourceFile` items always have `content`. Custom loaders that guarantee `content` receive these file methods too.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Loader name used in errors and metadata. |
| `cache` | `false` or `SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for origin state. |
| `resolveRevision(ctx)` | `function` | Optional. Pins a mutable origin ref to one revision before any other operation. |
| `prepare(ctx)` | `function` | Optional prefetch or validation hook. |
| `getKeys(ctx)` | `function` | Required. Returns all addressable Source keys. |
| `getItem(key, ctx)` | `function` | Required. Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional bulk item reader. |
| `getMeta(key, ctx)` | `function` | Optional metadata reader. |

`resolveRevision()` and `prepare()` each run at most once for every `createSource()` or `useSource()` reader, before its first operation. The resolved revision is added to the shared context. Revision-aware loaders use it for preparation, keys, items, and metadata. Loaders without revision support can observe origin changes. Create another reader to resolve a new revision. `getItems()` lets a consumer load all items in one call. `getMeta()` can return origin metadata without loading content.

### Source context

`createSource()` accepts a partial context and supplies the full `SourceContext` to each loader method. `useSource(name, context?)` uses the same reader lifecycle.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Base project directory. |
| `sourceRootDir` | `string` | None | Optional Source-specific root. Built-in local file loaders fall back to `rootDir` when it is absent. |
| `source` | `string` | Definition name, or registered name for `useSource()` | Identifies the active Source. |
| `workspace` | `string` | None | Identifies the Workspace that consumes the Source. |
| `abortSignal` | `AbortSignal` | None | Cancels in-flight work. Custom loaders must forward it to fetches and other abortable operations. |
| `revision` | `SourceRevision` | None | The revision pinned by `resolveRevision()` for every later operation in this reader or Workspace lifecycle. |

## Providers

Source has no provider configuration. Each loader reaches its own origin from the server runtime.

| Loader | Origin | Runtime requirement |
| --- | --- | --- |
| `file()`, `markdown()`, `glob()` | Local file system below the Source root | Reads files with `node:fs` when a reader loads them. The runtime file system must contain the files. Inline `content` needs no file system. |
| `github()` | GitHub repository | Network access to GitHub. When `root` or `include` narrows the files, it first tries a sparse Git checkout, then falls back to the repository tarball. |
| `mcpResources()` | MCP server | An MCP client or an `http` or `sse` transport the runtime can reach. |
| `defineSource()` | Any origin | Whatever the custom loader uses. |

Collections and Content need generated routes. The `vitehub()` Vite plugin installs `hubSource()` for every preset, and the Nuxt module installs the same behavior. Direct Source reads and the process-local registry do not need Vite.

## Source reader API

| Method | Returns |
| --- | --- |
| `source.revision()` | The pinned origin revision, when supported. |
| `source.keys()` | All Source keys. |
| `source.get(key)` | The loader's inferred item. Items can hold content, structured data, or both. |
| `source.items()` | All items. Uses `getItems()` when supplied, otherwise `getKeys()` and `getItem()`. |
| `source.read(key, options?)` | File readers only. Text by default, or `Uint8Array` with `{ encoding: 'binary' }`. |
| `source.meta(key)` | Metadata for one key, when the loader supports it. |
| `source.exists(key)` | Whether a key exists. |
| `source.list(prefix?)` | File readers only. Direct child files and directories below a prefix. |

```ts [server/api/docs.get.ts]
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)

  return {
    files: await reader.keys(),
    root: await reader.list(''),
  }
})
```

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

Import the module that registers Sources before you call `useSource()` in a process:

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

For typed name lookup, declare `ViteHubSourceMap` entries as `typeof` the matching definitions. The Vite integration does not discover a `server/sources` directory and does not generate this map. `RegisteredSource<'docs'>` resolves a registered name to its definition type.

## Combine keyed Source readers

Use `combineSources()` when several readers can return the same key. A combined reader identifies each item with a `[source, key]` tuple, so the source alias remains part of the runtime value and its inferred type.

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

Source aliases must be strings. `get()` infers the accepted key and result for each alias. `items()` exists only when every input reader implements it. Each listed item includes `source` and `identity`.

Use ordinary objects or functions for custom keyed readers. Use `defineSource()` for loaders that need the managed revision and preparation lifecycle.

### Cache a reader

```ts
import { cachedSource } from 'vite-hub/source/server'

const cachedRecaps = cachedSource(githubRecaps(process.cwd()), {
  name: 'recaps',
  maxAge: 60,
})

await cachedRecaps.get('2026-07')
```

`cachedSource(reader, options)` accepts an existing keyed reader and Nitro cache options. Cache ordinary readers before you pass them to `combineSources()`.

## Parse and serve content

Use [Content](/docs/server-primitives/content) when Source output should become parsed documents, navigation, queries, or full-text search. Pass the definition directly:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { docs } from './sources/docs'

export const content = defineContent({ source: docs })
```

Content opens a new reader for each refresh. Each load keeps its own revision, including when refreshes overlap. Pass a definition when Content should own that lifecycle. An explicitly supplied reader retains its caller-owned lifecycle.

## Expose a typed Collection

A Source describes where data comes from. A Collection describes the paginated object shape an application exposes to a client. For a discovered Drizzle database, let the database adapter own the keyset query:

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

`column` and `tieBreaker` must be non-null columns on the selected table, and the tie-breaker must be unique. The table source applies `where` before its lexicographic cursor predicate, orders both columns consistently, requests the extra row, and keeps the cursor opaque to clients. Omit `querySchema` and `where` when the Collection has no filters.

Use `defineCollection` with a loader function when the origin is a Source reader, SDK, HTTP API, joined query, or another loader whose pagination is not a single Drizzle table. The loader then owns its origin-specific cursor logic.

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

| Option | Description |
| --- | --- |
| `cursor` | Loader form only. Returns the cursor tuple for one row. |
| `cursorSchema` | Loader form only. Standard Schema that validates the decoded cursor. |
| `defaultLimit`, `maxLimit` | Page size when the client omits `limit` (default `50`), and the largest accepted `limit` (default `100`). |
| `querySchema` | Standard Schema that validates filter input. Its output type flows into the loader. |
| `transform` | Maps a server row to the client item. Its return type becomes the client item type. |
| `authorize` | `true` or an Auth access callback. See [Protect a Collection](#protect-a-collection). |

The generic Collection requests one extra row from the loader, enforces its configured limits, and turns the last visible row into an opaque cursor. `transform()` is the server-to-client boundary, so private columns and provider objects stay out of the response.

```vue [app/pages/articles.vue]
<script setup lang="ts">
const author = ref<string>()
const { items, pending, error, hasMore, loadMore } = useCollection('articles', {
  filter: computed(() => ({ author: author.value })),
})
</script>
```

ViteHub discovers modules in `server/collections` and generates their type registry and read-only GET routes. Each module exports a Collection with the same name as its filename, so `articles.ts` exports `articles` and maps to `/api/articles`. Do not create a matching `server/api` handler. The Nuxt module auto-imports `useCollection`. Outside Nuxt, import it from `vite-hub/source/client`. Restart Nuxt after you add, remove, or rename a Collection module so Nitro rebuilds its handler manifest.

`useCollection()` accepts `filter`, `limit`, `all`, `immediate`, and `request`. `filter` stays fixed while `loadMore()` advances the opaque cursor. For a bounded Collection, set `all: true` to fetch every page asynchronously.

### Protect a Collection

A Collection route is public through its transformed shape unless it declares `authorize`. `authorize: true` requires a signed-in [Auth](/docs/server-primitives/auth) session. A callback uses the Auth access signature: it receives `{ request, session, user }` and returns `true`, `false`, or a `Response`.

```ts [server/collections/meals.ts]
export const meals = defineCollection({
  source: table({ /* ... */ }),
  authorize: ({ user }) => user.role === 'owner',
  transform: meal => ({ id: meal.id, calories: meal.calories }),
})
```

The loader overload accepts the same option: `defineCollection(load, { authorize, ... })`. ViteHub checks access before it parses the query or loads rows. A request without a session returns JSON `401`, `false` returns `403`, and a returned `Response` is sent as-is. The check reads the same-origin session cookie, so `useCollection()` needs no extra headers. It sets `error` to a `CollectionAccessError` with `status` `401` or `403`:

```ts
import { CollectionAccessError } from 'vite-hub/source/client'

const { error } = useCollection('meals')
const signedOut = computed(() => error.value instanceof CollectionAccessError && error.value.status === 401)
```

Enable Auth and define `server/auth.ts` before you use `authorize`. Without Auth, the generated route cannot read a session and fails closed with `SOURCE_R0025`.

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content must appear inside a persistent Workspace file tree.

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

Workspace owns placement, materialization, sync, and access rules. The Source still owns retrieval. The binding above reuses the same definition as direct reads and Content. The key `intro.md` appears at `docs/intro.md` in the Workspace.

`vite-hub/workspace` also exports `file()`, `glob()`, `github()`, `markdown()`, `mcpResources()`, `fetch()`, and `custom()`. These helpers combine loader options with Workspace binding options.

## Production checks

- Sources are read-only. Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped Agent visibility.
- Read secrets for private origins, such as a GitHub token, from Server Env or a trusted `auth` callback. Never from model-authored input.
- Source paths are relative to the configured root. ViteHub rejects absolute paths, parent traversal, Windows drive paths such as `C:secrets.txt`, and null bytes on every host.
- `file()` follows a symbolic link only when its resolved target stays inside the Source root. `glob()` rejects an item when its file or a parent directory is a symbolic link. Set `followSymlinks: true` to follow links whose targets stay inside the root. These checks select files. They do not isolate the process from concurrent file system changes.
- Local Workspace Stores have a stricter contract and reject symlink access.
- Give each `cachedSource()` cache a name that identifies its origin and access scope. Do not share one cache name across callers who can see different data.
- `cursor` and `limit` are reserved Collection query parameters. Invalid limits, cursor encodings, and parsed filters return HTTP `400`.
- Collection `authorize` decides access to the whole route. It does not filter rows per user.

## Connect Source to Agents

Source has no Agent Capability of its own. Bind the Source to a [Workspace](/docs/server-primitives/workspace), then attach the [Workspace Shell Capability](/docs/capabilities/workspace-shell) so the Agent can inspect the mounted files. Workspace rules and access scopes decide what the Agent sees.

## Next steps

- Learn the shared model in [Workspace and Sources](/docs/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/server-primitives/workspace).
- Parse and search documents with [Content](/docs/server-primitives/content).
- Expose Workspace content to Agents through [Workspace Shell](/docs/capabilities/workspace-shell).
