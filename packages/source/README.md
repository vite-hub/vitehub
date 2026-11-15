# @vite-hub/source

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Sources" src="https://comark-ui.onmax.me/badge.svg?label=Source&amp;value=typed+retrieval">
</p>

`@vite-hub/source` loads files, globs, markdown, GitHub content, or custom data before something else places it in a workspace.

## Install

```sh
pnpm add @vite-hub/source
```

## Open a Source

```ts
import { createSource, glob } from "@vite-hub/source"

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

`glob()` treats both `/` and `\` as path separators in `include` and `ignore`,
including before wildcards: the JavaScript string `"docs\\*.md"` means
`"docs/*.md"`. Backslashes never escape glob metacharacters. To match literal
characters, use bracket expressions: `[*]` for `*`, `[?]` for `?`, and `[[]`
for `[`. For example, `"docs/file[[]1].md"` matches `docs/file[1].md`.
The same normalized patterns are used for discovery and final filtering.

`glob()` keeps its cached key listing in each reader. Opening another reader
refreshes that reader's listing without changing existing readers. File content
and metadata are read from the current file system. Set `keyCache: false` to
refresh keys on each listing and when an item is missing from the latest listing.

`file()` follows a symbolic link only when its resolved target stays inside the Source root. `glob()` is also confined to the Source root. It does not follow symbolic links by default, and it checks each file path again before it reads content or metadata. Set `followSymlinks: true` to follow links when their resolved targets stay inside the Source root. This option controls file selection. It does not isolate the process from concurrent file system changes.

File paths are relative to the Source root. Absolute paths, Windows drive paths such as `C:notes.md`, parent traversal, and null bytes are rejected on every host.

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

`github()` reads GitHub through `@vite-hub/forge`. `auth` is a token or a trusted
callback. Without `auth`, it reads Server Env `VITEHUB_GITHUB_TOKEN`, then
`FORGES_GITHUB_TOKEN`. It does not read `GH_TOKEN` or `GITHUB_TOKEN`.
`auth: false` reads without a token. `authenticated()` tells whether reads send a
token. Content serves a `github()` Source from a validated head commit only when
it does.

`history(key, { sha, page, perPage })` lists the commits that changed one file,
newest first, from the commit `sha` back. It reads GitHub's commits endpoint with
`path`, so it does not follow renames. Each commit has `sha`, `date`, `author`,
the first line of `message`, and `url`. `content.history()` uses it.

`latest(keys, { sha })` returns the latest commit of many files at once, as a
`Map` from key to commit. It sends one GitHub GraphQL request per 150 files, 4
at a time, so 2,600 files cost 18 requests. When GitHub stops a request after 10
seconds (502), it asks again with half the files. `changes(base, head)` returns
the keys that a commit from one commit to a later one changed, with a file that
one commit edits and a later one reverts. It sends one compare request, plus one
commit request per commit when there is more than one. It returns undefined when
GitHub cannot list them all or more than 20 commits lie between them. The Content sitemap and RSS feed
use both to date Source pages. `pullChanges(number)` returns the keys that a pull
request adds or changes, from its file list, with the new key of a renamed file
and without removed files. GitHub lists at most 3,000 files of a pull request.
`vitehub content previews comment` uses it.

`resolveRef()` returns the commit that a ref of the repository points to now:
`{ sha }` for `{ sha }` or `{ branch }`, and `{ sha, pull }` for `{ pull: 12 }`.
`pull` has the state, the head and base branches, `fork`, and the label names. A
branch must match its full name, and a SHA must be a full commit SHA. It returns
undefined when the repository has no such ref. Content uses it for
`content.sources.at()`.

`glob()` takes a pattern or options. In a pattern, the folders before the first
wildcard are `cwd`, so keys are the paths below them:

```ts
import { glob } from "@vite-hub/source"

export const docs = glob("content/docs/**/*.md") // keys like "guide/setup.md"
```

Under `vite dev` it reads the files from disk. A server build with `hubSource()`
bundles the files of a call whose options are literals, through `files()`, so
hosts without a runtime file system, such as Cloudflare Workers, serve them.
`files(entries, { base, prefix })` serves files the server already holds. An
entry can be the content or a function that loads it, such as an
`import.meta.glob()` loader. After removing `base`, a leading `./` is removed
from each key: `./content/a.md` becomes `content/a.md`, or `a.md` with
`base: "./content"`.

## Reuse a definition

Content accepts Source definitions directly. It opens a new reader on each
refresh, so overlapping loads keep separate revisions:

```ts fragment
import { defineContent } from "@vite-hub/content"

export default defineContent({ source: docs })
```

Workspace binds the same definition to a persistent file tree:

```ts fragment
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

```ts fragment
import { registerSources, useSource } from "@vite-hub/source"

registerSources({ docs })

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
`RegisteredSource<"docs">` resolves a registered name to its definition type.

## Split items into parts

`splitSource()` turns each item of a Source into several items, such as the
sections of a Markdown file. Each part key is `<parent key>#<part key>`:

```ts
import { createSource, splitSource, glob } from "@vite-hub/source"

const sections = splitSource({
  source: glob({ cwd: "docs", include: "**/*.md" }),
  split: file => String(file.content).split(/^## /m).slice(1)
    .map(section => ({ key: section.slice(0, section.indexOf("\n")), content: section })),
})

await createSource(sections).read("guide.md#Usage")
```

The result is a Source definition. `get()` reads only the parent item of the
part, and a part without a `path` keeps the parent's path. Part keys must be
unique in their parent item and must not contain `#`.

## Cache keyed readers

Use `cachedSource()` to add Nitro caching to a keyed reader. It loads
`nitro/cache` on the first `get()`, so the app must run on Nitro:

```ts fragment
import { cachedSource } from "@vite-hub/source/server"

const cachedDocs = cachedSource(createSource(docs), { name: "docs", maxAge: 60 })
await cachedDocs.get("intro.md")
```

Use a different cache name for each origin and access scope.

The `cache` option of a loader, such as `github({ cache: { maxAge } })`, is a
hint for the consumer of the Source. The Workspace reads it to decide when its
copy of the Source content is stale. A reader from `createSource()` alone does
not read `cache` and does not cache.

## Collections

Define a Collection when a database or other origin should become a typed,
paginated client read model:

```ts
// server/collections/articles.ts
import { defineCollection } from "@vite-hub/source"
import * as v from "valibot"

interface Article { id: string, title: string, createdAt: number }

export const articles = defineCollection(async ({ cursor, limit, query }) => {
  // A CMS API that pages by the last (createdAt, id) it returned
  const url = new URL("https://cms.example.com/api/articles")
  url.searchParams.set("limit", String(limit))
  if (cursor) url.searchParams.set("after", cursor.join(","))
  if (query.author) url.searchParams.set("author", query.author)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The CMS answered ${response.status}`)
  return await response.json() as Article[]
}, {
  access: 'public',
  cursor: article => [article.createdAt, article.id] as const,
  cursorSchema: v.tuple([v.number(), v.string()]),
  querySchema: v.object({ author: v.optional(v.string()) }),
  transform: article => ({ id: article.id, title: article.title }),
})
```

`cursorSchema` and `querySchema` accept any Standard Schema validator. Their
output types flow into the loader, so the loader needs no manual generic types.
The Collection exposes `querySchema` so tools such as `vitehub channels replay`
can describe the accepted query keys.

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
Each routed Collection must set `authorize` or `access: "public"`, or
`defineCollection()` throws `SOURCE_R0035`. `access: "public"` makes the route
public. `authorize: false` throws `SOURCE_R0037`, and `access: "public"` with
`authorize` throws `SOURCE_R0038`. `authorize: true`
requires a signed-in `@vite-hub/auth` session, and a callback receives
`{ request, session, user }` and returns `true`, `false` for `403`, or a
`Response`. The route checks access before it parses the query. Without a session
it returns `401`, and `useCollection()` sets `error` to a `CollectionAccessError`
with that `status`. Generated routes wrap the page with Auth's `withAuthorization` when the host
enables Auth with a discovered Auth Definition (`hubSource({ auth: true })`
alongside `hubAuth()` outside `vite-hub`); otherwise a
Collection with `authorize: true` or a callback fails closed. Set `route: false`
to keep a Collection server-only. Then neither is needed. Do not repeat the route under
`server/api`. Restart Nuxt after
adding, removing, or renaming a Collection module so Nitro rebuilds its handler
manifest.
Callers do not repeat URL strings or generic imports. `filter` is validated by
the Collection's query schema before the loader runs and remains fixed across
cursor pages. Set `all: true` for bounded Collections that should materialize
every page; otherwise call `loadMore()` explicitly. The loader owns the
origin-specific query. Collection owns limit enforcement, opaque cursor
transport, response shaping, and the exact item and filter types consumed by
`useCollection()`.

### Collections over an array

When the whole data set fits in memory, pass `array()` as the Collection source.
It filters, searches, sorts, counts, and pages the array, and returns `total` and
`facets` with each page:

```ts fragment
// server/collections/articles.ts
import { array, defineCollection } from "@vite-hub/source"

export const articles = defineCollection({
  access: 'public',
  source: array(() => loadArticles(), {
    facets: ["category"],
    filters: ["category", "authors.name"],
    key: "slug",
    search: ["title", "summary"],
    sort: { field: "title" },
  }),
  transform: article => ({ slug: article.slug, title: article.title }),
})
```

Clients filter with the declared field paths: `?category=guide` matches without
case, a repeated key matches any of its values, `?empty=category` matches items
with no value, and `?search=` matches the `search` fields. Any other key returns
`400`. Cursors are bound to the data and the query. A cursor from changed data or
another query returns `409`. `load` runs on every request; return
`{ items, digest }` when the origin already has a content digest, or ViteHub
hashes the items for pagination. Keyed lookups do not compute a digest.
`useCollection()` exposes `total` and `facets` from the latest
page. `key` adds `collection.get(key)` for server code, and `schema` validates
every item and types it from the schema output. Use a database `table()`
from `@vite-hub/source/drizzle` when the data set should not be loaded per
request. `table()` needs the optional `drizzle-orm` peer. Apps import it from
`vite-hub/source/drizzle`. `table()` selects every column. A public Collection
over it must set `transform` to return only the public fields, or
`defineCollection()` throws `SOURCE_R0036`:

```ts fragment
export const authors = defineCollection({
  access: 'public',
  source: table({ db, orderBy: { column: users.id, direction: "asc", tieBreaker: users.id }, table: users }),
  transform: ({ id, name }) => ({ id, name }),
})
```

Pass `{ signal }` to `collection.get(key, { signal })` to cancel a direct read.
Cancelled reads reject with the signal's reason, including when a loader or
transform returns after cancellation.

Keep binary assets behind the Blob boundary and store a serializable reference in
the record. This keeps ordinary record reads lazy while treating the structured
data and its assets as one logical item.

### Inspect Collections

`vitehub inspect definitions --kind collection` lists each discovered Collection
with its file, source kind, and the options that it sets: schema, key, sort,
filters, search, facets, limits, transform, authorize, and route. The
`hubSource()` plugin contributes this list through `vitehub.inspect`, and
`inspectCollectionDefinitions({ projectRoot, serverDirs })` from
`@vite-hub/source/vite` returns the same summaries. Inspection reads the module
text and does not run it, so a value that is computed at runtime shows as
`Dynamic`.

```txt
Collections (collection): 1
  articles  server/collections/articles.ts  [server-collections]
    Source: array
    Key: slug
    Sort: publishedAt desc
    Filters: category, authors.name
    Transform: Yes
    Route: GET /api/articles
```

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
