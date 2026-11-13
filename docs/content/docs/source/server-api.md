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
| `defineSource`, `createSource`, `splitSource` from `vite-hub/source` | Define loaders, open managed readers, and split items into parts. |
| `registerSource`, `registerSources`, `clearSources`, `useSource` from `vite-hub/source` | Manage and read the process-local Source registry. |
| `sourceIgnores` from `vite-hub/source` | Reuse ignore patterns for dependencies, generated output, media, secrets, and system files. |
| `file`, `files`, `glob`, `markdown`, and `github` from `vite-hub/source`, `mcpResources` from `vite-hub/source/mcp` | Select one built-in loader. Each entry also exports the option types of its loaders. `mcpResources` has its own entry because it loads the MCP SDK. |
| `defineCollection`, `array` from `vite-hub/source` | Turn an array or a custom loader into a typed, paginated HTTP read model. |
| `table` from `vite-hub/source/drizzle` | Turn a Drizzle table into a Collection. It needs `drizzle-orm`. |
| `useCollection`, `CollectionAccessError` from `vite-hub/source/client` | Read a Collection in Vue and detect access errors. |
| `cachedSource`, `defineCollectionHandler` from `vite-hub/source/server` | Cache a reader with Nitro cache options, or mount a Collection route by hand as a Fetchable, `{ fetch(request) }`. |
| `hubSource` from `vite-hub/source/vite` | Finds Collections and Content and generates their routes. `vitehub()` and the Nuxt module add it. |
| `useDatabase` from `vite-hub/database` | Get a database and its generated schema for `table()`. |
| `getViteHubErrorShape` from `vite-hub/runtime` | Read registry, path, and loader failures by `SOURCE_*` code. |

Source, Source Reader, Source Item, revision, cache, and error types are exported from `vite-hub/source`. Libraries that install `@vite-hub/source` directly use the matching `@vite-hub/source/*` paths. Each `vite-hub/source/*` path re-exports the matching `@vite-hub/source/*` path unchanged.

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
import { registerSources, file, github } from 'vite-hub/source'

export const sources = {
  readme: file('README.md'),
  docs: github({
    repo: 'acme/docs',
    ref: 'main',
    root: 'docs',
    include: ['**/*.md'],
  }),
}

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
import { createSource, splitSource, glob } from 'vite-hub/source'

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

## Cache a Source reader

Plain objects or functions work as readers. Use `defineSource()` when a loader needs the revision and `prepare()` steps.

```ts fragment
import { cachedSource } from 'vite-hub/source/server'

const recaps = {
  async get(month: `${number}-${number}`) {
    return { month }
  },
}

const cachedRecaps = cachedSource(recaps, {
  name: 'recaps',
  maxAge: 60,
})

await cachedRecaps.get('2026-07')
```

`cachedSource(reader, options)` takes a reader and Nitro cache options.

## Expose a typed Collection

A Collection is the paged list that your app serves to clients. For a Drizzle database, let `table()` build the query. This example reads the `articles` table of the default Database:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    articles: sqliteTable('articles', {
      id: text('id').primaryKey(),
      title: text('title').notNull(),
      author: text('author').notNull(),
      createdAt: integer('created_at').notNull(),
    }),
  },
})
```

```ts [server/collections/articles.ts] fragment
import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import { useDatabase } from 'vite-hub/database'
import { defineCollection } from 'vite-hub/source'
import { table } from 'vite-hub/source/drizzle'

const { db, schema } = useDatabase('default')

export const articles = defineCollection({
  authorize: false,
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

`table()` selects every column. A public Collection (`authorize: false`) over it must set `transform` and return only the public fields. Without `transform`, `defineCollection()` throws `SOURCE_R0036`, so a column such as a password hash never reaches the route.

Pass a loader function to `defineCollection` when the data is not one Drizzle table, such as a Source reader, SDK, HTTP API, or joined query. The loader then handles its own cursor.

```ts [server/collections/articles.ts]
import { defineCollection } from 'vite-hub/source'
import * as v from 'valibot'

interface Article { id: string, title: string, createdAt: number }

export const articles = defineCollection(async ({ cursor, limit, query }) => {
  // A CMS API that pages by the last (createdAt, id) it returned
  const url = new URL('https://cms.example.com/api/articles')
  url.searchParams.set('limit', String(limit))
  if (cursor) url.searchParams.set('after', cursor.join(','))
  if (query.author) url.searchParams.set('author', query.author)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The CMS answered ${response.status}`)
  return await response.json() as Article[]
}, {
  authorize: false,
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
| `authorize` | Required unless `route: false`. `true`, an Auth access callback, or `false` for a public route ([Protect a Collection](#protect-a-collection)). |

The Collection asks the loader for one extra row, enforces the limits, and turns the last row into a cursor. Only `transform()` output reaches the client, so private columns and provider objects stay out.

### Collections over an array

When all the data fits in memory, use `array()`. It filters, searches, sorts, and pages the array. Each page has `total` and `facets`:

```ts [server/collections/articles.ts] fragment
import { array, defineCollection } from 'vite-hub/source'

export const articles = defineCollection({
  authorize: false,
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
- Each routed Collection must set `authorize`. Without it, `defineCollection()` throws `SOURCE_R0035`.
- Set `route: false` to keep a Collection server-only. Then `authorize` is optional. Write it as a literal in the exported call, for example `export const drafts = defineCollection({ source, route: false })`. The build reads the file and does not run it. For any other form, it still writes the route, and the route answers `404`.

To serve a Collection from another route, export `defineCollectionHandler(collection)` from the route file. It returns a Fetchable, `{ fetch(request) }`, that reads `cursor`, `limit`, and the filters from the request URL. A bad query or cursor returns JSON `400` and a stale cursor returns `409`, both as `{ status, message }`:

```ts [server/routes/feed.get.ts]
import { defineCollectionHandler } from 'vite-hub/source/server'
import { articles } from '../collections/articles'

export default defineCollectionHandler(articles)
```

A Collection with `authorize: true` or a callback also needs `withAuthorization` from `vite-hub/auth/server`: `defineCollectionHandler(meals, { withAuthorization })`. A Collection object without `authorize` throws `SOURCE_R0035`.

`useCollection()` accepts `filter`, `limit`, `all`, `immediate`, and `request`. `filter` stays fixed while `loadMore()` moves the cursor. For a small Collection, `all: true` fetches every page in the background. It returns `items`, `pending`, `error`, `hasMore`, `loadMore()`, and `refresh()`, plus `total` and `facets` from the latest page when present.

### Protect a Collection

::warning
A routed Collection must set `authorize`. `authorize: false` makes the route public, so set it only when every item is safe for anyone to read.
::

`authorize: true` requires a signed-in [Auth](/docs/auth) session. A callback gets `{ request, session, user }` and returns `true`, `false`, or a `Response`. `authorize: false` needs no Auth.

```ts [server/collections/drafts.ts]
import { useDatabase } from 'vite-hub/database'
import { defineCollection } from 'vite-hub/source'
import { table } from 'vite-hub/source/drizzle'

const { db, schema } = useDatabase('default')

export const drafts = defineCollection({
  source: table({
    db,
    table: schema.articles,
    orderBy: { column: schema.articles.createdAt, direction: 'desc', tieBreaker: schema.articles.id },
  }),
  authorize: ({ user }) => user?.role === 'owner',
  transform: article => ({ id: article.id, title: article.title }),
})
```

The loader form takes it too: `defineCollection(load, { authorize, ... })`. ViteHub checks access before it parses the query or loads rows.

- No session returns JSON `401`. `false` returns `403`. A returned `Response` is sent as is.
- The check reads the same-origin session cookie, so `useCollection()` needs no extra headers. It sets `error` to a `CollectionAccessError` with `status` `401` or `403`:

```ts [app/composables/drafts.ts]
import { computed } from 'vue'
import { CollectionAccessError, useCollection } from 'vite-hub/source/client'

export function useDraftsSignedOut() {
  const { error } = useCollection('drafts')
  return computed(() => error.value instanceof CollectionAccessError && error.value.status === 401)
}
```

Enable Auth and add `server/auth.ts` before you use `authorize: true` or a callback. Without Auth, the route cannot read a session and denies every request with `SOURCE_R0025`.

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
