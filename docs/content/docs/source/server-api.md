---
title: Source server API
description: Open Source readers, register and combine Sources, cache readers, and expose typed Collections.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Use these imports and methods to read Sources from server code and expose them to clients.

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

A Collection route is public through its transformed shape unless it declares `authorize`. `authorize: true` requires a signed-in [Auth](/docs/auth) session. A callback uses the Auth access signature: it receives `{ request, session, user }` and returns `true`, `false`, or a `Response`.

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
