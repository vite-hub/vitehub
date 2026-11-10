---
title: Source server API
description: Open Source readers, register and combine Sources, cache readers, and serve typed Collections.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

A Source describes where data comes from, and a reader reads it. Use these APIs in server code.

## Public imports

| Import | Use |
| --- | --- |
| `defineSource`, `defineSources`, `createSource`, `combineSources`, `splitSource` from `vite-hub/source` | Define loaders, open readers, combine readers, and split items into parts. |
| `registerSource`, `registerSources`, `clearSources`, `getRegisteredSource`, `useSource` from `vite-hub/source` | Manage and read the in-process Source registry. |
| `sourceIgnores` from `vite-hub/source` | Ignore patterns for dependencies, build output, media, secrets, and system files. |
| `file` from `vite-hub/source/file`, `glob` from `vite-hub/source/glob`, `markdown` from `vite-hub/source/markdown`, `github` from `vite-hub/source/github`, `mcpResources` from `vite-hub/source/mcp` | One built-in loader each. Each path also exports its option types. |
| `defineCollection`, `array`, `table` from `vite-hub/source` | Turn an array, a Drizzle table, or your loader into a typed, paged HTTP route. |
| `workspaceFile` from `vite-hub/workspace` | Use a JSON array in a Workspace file as a Collection source. |
| `useCollection`, `CollectionAccessError` from `vite-hub/source/client` | Read a Collection in Vue and detect access errors. |
| `cachedSource`, `defineCollectionHandler` from `vite-hub/source/server` | Cache a reader with Nitro cache options, or mount a Collection handler by hand. |
| `hubSource` from `vite-hub/source/vite` | Finds Collections and Content and generates their routes. `vitehub()` and the Nuxt module add it. |
| `useDatabase` from `vite-hub/database` | Get a database and its generated schema for `table()`. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Read registry, path, and loader failures by `SOURCE_*` code. |

`vite-hub/source` exports the Source, reader, item, revision, cache, and error types. Libraries that install `@vite-hub/source` use the matching `@vite-hub/source/*` paths. `table()` and `cachedSource()` exist only in `vite-hub`. `@vite-hub/source` exports both forms of `defineCollection()` and `array()`.

## Source reader API

| Method | Returns |
| --- | --- |
| `source.revision()` | The pinned revision, when supported. |
| `source.keys()` | All Source keys. |
| `source.get(key)` | The loader's typed item, with content, data, or both. |
| `source.items()` | All items, from `getItems()` when set, else `getKeys()` and `getItem()`. |
| `source.read(key, options?)` | File readers only. Text by default, or `Uint8Array` with `{ encoding: 'binary' }`. |
| `source.meta(key)` | Metadata for one key, when the loader supports it. |
| `source.exists(key)` | Whether a key exists. |
| `source.list(prefix?)` | File readers only. Direct child files and folders below a prefix. |

```ts [server/api/docs.get.ts] fragment
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

Register Sources only to look them up by name. `createSource()` calls do not need it.

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

Import the module that registers Sources before you call `useSource()`:

```ts [server/api/readme.get.ts]
import { defineEventHandler } from 'h3'
import '../sources'
import { useSource } from 'vite-hub/source'

export default defineEventHandler(async () => {
  const readme = useSource('readme')

  return {
    text: await readme.read('README.md'),
  }
})
```

For typed lookup, declare `ViteHubSourceMap` entries as `typeof` each definition. The Vite plugin does not scan a `server/sources` folder or generate this map. `RegisteredSource<'docs'>` gives the definition type of a registered name.

## Split items into parts

Use `splitSource()` when one file holds many items, such as Markdown sections or CSV rows. `split()` gets one parent item and returns its parts. Each part becomes an item with the key `<parent key>#<part key>`.

```ts [server/sections.ts]
import { createSource, splitSource } from 'vite-hub/source'
import { glob } from 'vite-hub/source/glob'

export const sections = splitSource({
  source: glob({ cwd: 'docs', include: '**/*.md' }),
  split: file => String(file.content)
    .split(/^## /m)
    .slice(1)
    .map(section => ({ key: section.slice(0, section.indexOf('\n')), content: section })),
})

const reader = createSource(sections)
await reader.keys()
// ['guide.md#Install', 'guide.md#Usage']
await reader.read('guide.md#Usage')
```

Content, Workspaces, and `createSource()` accept a split Source. A part without `path` keeps the parent's. `get()` reads only that part's parent; `keys()` and `items()` read all parents. Part keys must be unique per parent and without `#`.

## Combine keyed Source readers

Use `combineSources()` when several readers can return the same key. The combined reader names each item with a `[source, key]` tuple, so the source alias stays in the value and its type.

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

Aliases must be strings. `get()` infers the key and result for each alias. `items()` exists only when every reader has it. Each listed item has `source` and `identity`.

Plain objects or functions work as readers. Use `defineSource()` when a loader needs the revision and `prepare()` steps.

### Cache a reader

```ts fragment
import { cachedSource } from 'vite-hub/source/server'

const cachedRecaps = cachedSource(githubRecaps(process.cwd()), {
  name: 'recaps',
  maxAge: 60,
})

await cachedRecaps.get('2026-07')
```

`cachedSource(reader, options)` takes a reader and Nitro cache options. Cache plain readers before you pass them to `combineSources()`.

## Expose a typed Collection

A Collection is the paged list that your app serves to clients. For a Drizzle database, let `table()` build the query:

```ts [server/collections/articles.ts]
import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import { useDatabase } from 'vite-hub/database'
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

`column` and `tieBreaker` must be non-null columns, and `tieBreaker` unique. `table()` applies `where` before the cursor condition, orders both columns the same way, fetches one extra row, and hides the cursor from clients. Omit `querySchema` and `where` without filters.

Pass a loader function to `defineCollection` when the data is not one Drizzle table, such as a Source reader, SDK, HTTP API, or joined query. The loader then handles its own cursor.

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
| `cursorSchema` | Loader form only. Standard Schema for the decoded cursor. |
| `defaultLimit`, `maxLimit` | Page size without `limit` (default `50`), and the largest `limit` (default `100`). |
| `querySchema` | Standard Schema for filter input. Its output type goes to the loader. |
| `transform` | Maps a server row to the client item, and sets the client item type. |
| `authorize` | `true` or an Auth access callback ([Protect a Collection](#protect-a-collection)). |

The Collection asks the loader for one extra row, enforces the limits, and turns the last row into a cursor. Only `transform()` output reaches the client, so private columns and provider objects stay out.

### Collections over an array

When all the data fits in memory, use `array()`. It filters, searches, sorts, and pages the array. Each page has `total` and `facets`:

```ts [server/collections/articles.ts] fragment
import { array, defineCollection } from 'vite-hub/source'

export const articles = defineCollection({
  source: array(() => loadArticles(), {
    filters: ['category', 'authors.name'],
    search: ['title', 'summary'],
    facets: ['category'],
    sort: { field: 'publishedAt', direction: 'desc' },
    key: 'slug',
  }),
  transform: article => ({ slug: article.slug, title: article.title }),
})
```

| Option | Description |
| --- | --- |
| `filters` | Fields a client can filter by. `?category=guide` ignores case. A repeated key matches any value. `?empty=category` matches items with no value. Dot paths read nested objects and every element of nested arrays. A `Date` matches its ISO string. |
| `search` | Fields that `?search=` matches as a substring, ignoring case. Without it, a non-empty `search` returns `400`. |
| `facets` | Fields counted into `page.facets` as `{ value, count }` lists over all matches. |
| `sort` | Field and direction. Numbers sort by value, `Date` by time. Omit it to keep the array order. |
| `key` | Field that `collection.get(key)` matches in server code. |
| `schema` | Standard Schema for one item. Each item is checked on load, and the output type is the item type. |
| `defaultLimit`, `maxLimit` | Page size and the largest `limit`. `maxLimit` also caps the values per facet. |

The loader runs per request and returns the array or `{ items, digest }`. Cursors are tied to the digest and query, so one from changed data or another filter returns `409`. Without `digest`, ViteHub hashes the items. Server code can filter any field: `articles.page({ query: { category: ['guide'] } })`.

`workspaceFile()` does the same for a JSON array in a Workspace file:

```ts [server/collections/articles.ts]
import * as v from 'valibot'
import { defineCollection } from 'vite-hub/source'
import { workspaceFile } from 'vite-hub/workspace'

export const articles = defineCollection({
  source: workspaceFile({
    workspace: 'content',
    path: 'data/articles.json',
    schema: v.object({ slug: v.string(), title: v.string(), category: v.optional(v.string()) }),
    filters: ['category'],
    search: ['title'],
  }),
})
```

Cursors are tied to the file's Workspace digest, so a write makes older cursors stale. Without `schema`, items are `Record<string, unknown>`.

```vue [app/pages/articles.vue]
<script setup lang="ts">
const author = ref<string>()
const { items, pending, error, hasMore, loadMore } = useCollection('articles', {
  filter: computed(() => ({ author: author.value })),
})
</script>
```

ViteHub finds modules in `server/collections` and generates their types and read-only GET routes.

- Export a Collection named like the file: `articles.ts` exports `articles` and serves `/api/articles`. Do not add a matching `server/api` handler.
- Nuxt auto-imports `useCollection`. Elsewhere, import it from `vite-hub/source/client`.
- Restart Nuxt after you add, remove, or rename a Collection, so Nitro rebuilds its handler list.

`useCollection()` accepts `filter`, `limit`, `all`, `immediate`, and `request`. `filter` stays fixed while `loadMore()` moves the cursor. For a small Collection, `all: true` fetches every page in the background. It returns `items`, `pending`, `error`, `hasMore`, `loadMore()`, and `refresh()`, plus `total` and `facets` from the latest page when present.

### Protect a Collection

::warning
A Collection route is public unless it sets `authorize`.
::

`authorize: true` requires a signed-in [Auth](/docs/auth) session. A callback gets `{ request, session, user }` and returns `true`, `false`, or a `Response`.

```ts [server/collections/meals.ts]
export const meals = defineCollection({
  source: table({ /* ... */ }),
  authorize: ({ user }) => user.role === 'owner',
  transform: meal => ({ id: meal.id, calories: meal.calories }),
})
```

The loader form takes it too: `defineCollection(load, { authorize, ... })`. ViteHub checks access before it parses the query or loads rows.

- No session returns JSON `401`. `false` returns `403`. A returned `Response` is sent as is.
- The check reads the same-origin session cookie, so `useCollection()` needs no extra headers. It sets `error` to a `CollectionAccessError` with `status` `401` or `403`:

```ts
import { CollectionAccessError } from 'vite-hub/source/client'

const { error } = useCollection('meals')
const signedOut = computed(() => error.value instanceof CollectionAccessError && error.value.status === 401)
```

Enable Auth and add `server/auth.ts` before you use `authorize`. Without Auth, the route cannot read a session and denies every request with `SOURCE_R0025`.

### Inspect Collections

`vitehub inspect definitions --kind collection` lists each Collection. It reads the module text and does not run it.

```bash [Terminal]
pnpm vitehub inspect definitions --kind collection
```

```txt [Output]
Collections (collection): 1
  articles  server/collections/articles.ts  [server-collections]
    Source: array
    Schema: v.object(...)
    Schema fields: slug, title, category, publishedAt
    Key: slug
    Sort: publishedAt desc
    Filters: category, authors.name
    Search: title, summary
    Facets: category
    Transform: Yes
    Route: GET /api/articles
```

- `Source` is `array`, `table`, another helper name, `custom` for a source object, or `loader` for `defineCollection(load, options)`.
- Other fields show only options that the Collection sets. `table()` shows `Table`, `Sort`, `Query schema`, and `Where`. A custom source or loader shows `Pagination`, `Cursor schema`, and `Query schema`.
- `Schema fields` lists the top-level keys of an inline `object({ ... })` schema.
- A runtime value shows as `Dynamic`. A non-literal source shows as `unknown`.
- `Route` is the GET route or `Disabled`. `Authorize` is `Signed-in session` for `true` and `Callback` for a function.

Add `--json` for JSON output.
