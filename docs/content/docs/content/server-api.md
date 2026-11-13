---
title: Content server API
description: Read documents, navigation, and search results, and save, publish, and inspect document collections from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineContent` from `vite-hub/content` | Define the Content runtime that ViteHub serves from `server/content.ts`. |
| `documents`, `singleton` from `vite-hub/content/collections` | Define an editable collection or a singleton. This entry needs `@vite-hub/workspace`. |
| `optional` from `vite-hub/content` | Mark a field optional. |
| `cms` from `vite-hub/cms` | Store collections with `defineContent({ extends: cms })`. See [CMS](/docs/cms). |
| `seo` from `vite-hub/content` | A per-document [SEO field](/docs/content/seo#seo-fields). |
| `image`, `file` from `vite-hub/content` | [Blob reference](/docs/blob/server-api#blob-reference-schemas) fields. Blob owns them, and `vite-hub/blob` exports them too. |
| `contentSessionsSchema` from `vite-hub/content/database` | The table behind [`content.sessions`](/docs/content/editing-together). Add it to the Workspace history Database. |
| `contentSessionTimeouts` from `vite-hub/content` | Presence, lease, and idle durations in milliseconds: `{ presence: 45_000, lease: 300_000, idle: 900_000 }`. |
| `contentHead` from `vite-hub/content` or `vite-hub/content/client` | A document's [head tags](/docs/content/seo#head-tags), in the `useHead()` shape. |
| `defineContentSitemapHandler`, `defineContentRobotsHandler`, `renderContentSitemap` from `vite-hub/content` | Serve or render the [sitemap and robots.txt](/docs/content/seo#sitemap-and-robotstxt) in another server. |
| `contentSource` from `vite-hub/content` | Adapt one Source with Comark options such as `prefix` and `schema`, and a sitemap [`url`](/docs/content/seo#source-urls). |
| `renderContentHtml` from `vite-hub/content` | [Render a document to HTML](/docs/content/configure#render-html-on-the-server) in a server route without a framework. |
| `defineContentHandler` from `vite-hub/content` | Serve a Content runtime as a Fetchable route, `{ fetch(request) }`, in another server. Nitro and H3 accept it as a route handler. |
| `generateContentTypes`, `defineContentTypesPlugin` from `vite-hub/content` | Generate the [Content types](#types), or write them from a Nitro plugin in development. |
| `createContentClient`, `defineContentClientPlugin` from `vite-hub/content/client` | Use or extend the typed Comark Content client. |
| `createContentEditorCodec`, `contentRealtimeEditor`, `ContentImage` from `vite-hub/content/editor` | Content's editor codec, Realtime adapter, and image extension. See [Live editing](/docs/content/editing-together#build-your-own-live-editor). |
| `contentField`, `formatContentField`, `parseContentField` from `vite-hub/content/client` | Mark the element that renders a field, and read its [field address](#field-addresses). |
| `comark-content/database/*`, `comark-content/plugins/*`, `comark-content/sources/*` | Optional Comark databases, plugins, and native Sources. Install `comark-content` to import these. |

Libraries can install `@vite-hub/content` and import from `@vite-hub/content` and `@vite-hub/content/client`. `documents` and `optional` come from `@vite-hub/content/collections`, which needs `@vite-hub/workspace`. Read-only Content needs no Workspace or Database. Without `vitehub()`, add `hubContent()` from `@vite-hub/content/vite`. For the `cms` preset, also install `@vite-hub/cms` and add `hubCms()` from `@vite-hub/cms/vite` next to the Workspace, Database, and Blob plugins. See [Without vitehub()](/docs/cms/server-api#without-vitehub). Only `vitehub()` turns these plugins on for you.

## Runtime API

`defineContent()` returns a Comark Content hub with ViteHub adapters for named Sources and collections. The examples on this page use this definition: a read-only `docs` Source, a `posts` collection, and a `settings` singleton.

```ts [server/content.ts]
import sqlite from 'comark-content/database/sqlite-node'
import sqliteFullTextSearch from 'comark-content/plugins/sqlite-full-text-search'
import { cms } from 'vite-hub/cms'
import { defineContent } from 'vite-hub/content'
import { documents, singleton } from 'vite-hub/content/collections'
import { glob } from 'vite-hub/source'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
  collections: {
    posts: documents({
      path: 'posts/**/*.md',
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
    settings: singleton({ path: 'settings.json', fields: { title: z.string() } }),
  },
  authorize: ({ user, action }) => user?.role === 'admin' || (user?.role === 'editor' && action !== 'publish'),
})
```

Editors can read and edit drafts; admins can also publish.

| Method | Behavior |
| --- | --- |
| `content.get(path)` | One parsed document by public path, such as `/guide`. |
| `content.list(names?)` | Lists documents. Takes one instance name or an array. |
| `content.navigation(names?)` | One navigation tree across the selected instances. |
| `content.search(names, query, options?)` | Full-text search across the named instances. Needs the `sqlite-full-text-search` plugin. |
| `content.init()` | Loads and parses every instance. |
| `content.getSource(name?)` | The Comark Source of one instance. Defaults to `default`. |
| `content.handler(request)` | Answers a Web `Request`. The generated route calls it through `defineContentHandler()`. |

```ts [server/utils/guide.ts]
import content from '../content'

export async function readGuide() {
  await content.get('/guide')
  await content.navigation(['docs'])
  await content.search(['docs'], 'runtime')
}
```

Plugin methods, such as SQL queries, stay on the runtime. A collection serves published documents at paths that follow the Workspace path, so `posts/hello.md` is `/posts/hello`. `get`, `list`, `navigation`, `search`, and `handler` first check the `published` head and refresh collections that are behind. A [preview request](/docs/content/preview) reads the `draft` head instead. Plugin methods read the last refreshed published state.

### Cache

Comark Content owns the parsed document cache. ViteHub sends each cache call to the instance that owns the entry.

| Method | Behavior |
| --- | --- |
| `content.cache.refresh(name)` | Reloads one instance from its Source. |
| `content.cache.invalidate(key)`, `content.cache.expire(key)` | Invalidates or expires one entry. Keys start with the instance name, such as `docs:guide/index.md`. |
| `content.cache.get(key)`, `content.cache.set(key, value)` | Reads or writes one cache entry. |
| `content.cache.keys(name?)`, `content.cache.clear(name?)` | Lists or clears entries of one instance or all. |
| `content.cache.snapshot(name, options?)` | Refreshes one instance and builds a Comark cache artifact. |

### Types

`vite dev` types the `data` of `content.get()`, `content.list()`, and `content.query()` for you. When the server starts, and again after Content changes, ViteHub writes `.vitehub/types/content.d.ts` from the schema of each Source and collection. A collection uses its fields. Comark infers the schema of a Source from its documents.

```ts [server/api/about.get.ts] fragment
import { defineEventHandler } from 'h3'
import content from '../content'

export default defineEventHandler(async () => {
  const page = await content.get('/about')
  return page?.data.title // string, from the frontmatter of docs/about.md
})
```

A path or name that the file does not list has `data` typed as `Record<string, any>`. `.vitehub` is not committed, so a fresh checkout, such as in CI, has no file: `get()` and `list()` use that type, and `query()` rows use `Record<string, unknown>`. To type check with the file there, write the output of `generateContentTypes(content, { moduleName: "vite-hub/content" })` from `vite-hub/content` to `.vitehub/types/content.d.ts` in a script that loads your Content. Generation reads every Source and the `published` ref of every collection in the background. A failure prints one `Could not generate Content types` warning.

In development, Content lists a new or renamed Source file after a restart or `content.cache.refresh(name)`, and the types follow the same list.

### Client

`createContentClient()` calls `/api/content` by default. Pass `instances` to search named Sources. Client plugins, such as `comark-content/plugins/sqlite-full-text-search/client`, add methods that match server plugins.

## Collections

`content.collection(name)` opens a collection from [`defineContent({ collections })`](/docs/content/configure#document-collections). These methods are trusted server API and skip `authorize`. When a route acts for a user, check [`content.can()`](#access) first.

```ts [server/api/posts/[id].put.ts]
import { defineEventHandler, getRouterParam, readValidatedBody } from 'h3'
import * as v from 'valibot'
import content from '../../content'

const post = v.object({
  data: v.object({ title: v.string(), date: v.string(), tags: v.array(v.string()) }),
  body: v.string(),
  digest: v.nullable(v.string()),
})

export default defineEventHandler(async (event) => {
  const { data, body, digest } = await readValidatedBody(event, post)
  return await content.collection('posts').save(getRouterParam(event, 'id')!, { data, body }, { ifDigest: digest })
})
```

| Method | Behavior |
| --- | --- |
| `content.collections()` | Every collection and singleton, in definition order, as `content.collection(name)` returns them, with `name`, `kind`, `format`, `path`, `fields`, and `schema`. Narrow with `kind`. Empty without `collections`. |
| `posts.list(options?)` | Lists documents without body as `{ items, nextCursor, total, facets? }`. Reads `published` unless `ref: 'draft'` or a preview request. |
| `posts.get(id, options?)` | One document, or `null`. Reads `published` unless `ref: 'draft'` or a preview request, or one history revision with `revision`. |
| `posts.raw(id, options?)` | The stored file as `{ collection, id, path, text, digest, revision }`, or `null`, not parsed or validated. Takes `ref` or `revision` like `get()`. |
| `posts.save(id, { data, body }, options?)` | Commits the file to `draft` and returns the document. Invalid fields are stored and returned as `issues`. See [Drafts in progress](/docs/content/configure#drafts-in-progress). |
| `posts.remove(id, options?)` | Deletes the document from `draft`. It stays published until the next `publish()`. |
| `posts.restore(id, revision, options?)` | Saves the document from an earlier revision as the new draft. |
| `posts.status(id?)` | Compares `draft` and `published` for one document, or all without `id`. |
| `posts.name`, `posts.path`, `posts.fields` | The collection name, its glob, and its field names in definition order. |
| `posts.kind`, `posts.format` | `documents` for a collection, and `markdown`, `json`, or `yaml` from the [file extension](/docs/content/configure#data-files). |
| `posts.routable`, `posts.seo` | Whether documents have a [`url`](/docs/content/seo#document-urls), and the name of the `seo()` field, if any. |
| `posts.label`, `posts.singularLabel`, `posts.titleField` | The display name, the singular name from `label: { singular, plural }`, and the string field that names a document. See [Define collections](/docs/content/configure#define-collections). |
| `posts.schema` | The fields' [JSON Schema](/docs/content/configure#json-schema). |
| `content.publish(options?)` | Copies draft documents to `published` in one revision. Pass `expect` to publish exactly what was reviewed. |
| `content.schedule({ at, expect })`, `content.schedules()`, `content.unschedule(id)`, `content.publishDue()` | Publish reviewed drafts later, list and cancel schedules, and run due ones. See [Scheduling](/docs/content/scheduling). |
| `content.revisions(collection, id?, options?)` | Revisions that saved, removed, restored, or published one document, newest first. Omit `id` for a singleton. |
| `content.revisions(options?)` | Revisions that changed any collection's documents on one ref, newest first. |
| `content.can({ user?, actor?, collection, action, id? })` | Evaluates `authorize`. Returns `false` when no policy is defined. |
| `content.hasPolicy` | Whether `defineContent({ authorize })` has a policy. |
| `content.sessions.report()`, `.acquire()`, `.release()`, `.list()` | Presence and edit leases of documents. See [Editing together](/docs/content/editing-together). |
| `posts.editing` | `{ lease }` from the definition's `editing` option. |
| `content.sitemap(options?)` | [Sitemap entries](/docs/content/seo#sitemap-and-robotstxt) `{ collection, id, loc, lastmod? }` of published, indexable documents and Source documents that have a URL. |
| `content.robots(options?)` | The robots.txt text for `defineContent({ seo: { robots } })`. |

To work on documents from a terminal during development, use [`vitehub content`](/docs/content/cli).

A document is `{ collection, id, path, data, body, digest, revision, updatedAt }`. `path` is the Workspace file. `data` holds the validated field values. `digest` is the SHA-256 of the file bytes. `body` is the Markdown body, empty for JSON and YAML. `revision` is the revision it was read from. With a collection [`url`](/docs/content/seo#document-urls), `url` is its public path or `null`.

`updatedAt` is the `createdAt` of the newest revision on the read ref that changed the file: on `published`, the last publish of it, and on `draft`, the last save or restore, or the revision that started the draft. Content walks the ref back once per revision per runtime and stops at a known answer. It is `null` when the change is older than the 5,000 revisions one walk scans.

### Singletons

A [`singleton()`](/docs/content/configure#singletons-and-data-files) has `kind: 'singleton'`, and its methods take no id:

| Method | Behavior |
| --- | --- |
| `settings.get(options?)` | The document, or `null` before its first save on that ref. |
| `settings.raw(options?)` | The stored file, not parsed or validated, or `null`. |
| `settings.save({ data, body? }, options?)` | Commits to `draft`, with `issues` for invalid fields. The first save creates it. |
| `settings.remove(options?)` | Deletes the document from `draft`. |
| `settings.restore(revision, options?)` | Saves the document from an earlier revision as the new draft. |
| `settings.status()` | `{ collection, id, state, draft, published }`, or `null` when it exists on neither ref. |
| `settings.list(options?)` | A page with the document, if it exists on the ref. |
| `settings.id`, `settings.path` | The document id (the file name without extension) and its Workspace path. |

Each method also takes the id first, like a collection, so generic code need not branch: `settings.get('settings')` equals `settings.get()`. Any other id throws `CONTENT_R0008`. `publish({ expect })` entries for a singleton can omit `id`:

```ts [server/utils/settings.ts]
import content from '../content'

export async function publishSettings() {
  const settings = content.collection('settings')
  const { draft } = (await settings.status())!
  await content.publish({ expect: [{ collection: 'settings', digest: draft }] })
}
```

### List documents

```ts [server/utils/vue-posts.ts]
import content from '../content'

export async function vuePosts() {
  const page = await content.collection('posts').list({
    filter: { tags: 'vue' },
    search: 'hydration',
    sort: { field: 'date', direction: 'desc' },
    facets: ['tags'],
    limit: 20,
  })
  const next = page.nextCursor
    ? await content.collection('posts').list({ filter: { tags: 'vue' }, search: 'hydration', sort: { field: 'date', direction: 'desc' }, limit: 20, cursor: page.nextCursor })
    : undefined
  return { page, next }
}
```

| Option | Behavior |
| --- | --- |
| `ref` | `published` or `draft`. Defaults to `draft` in a [preview request](/docs/content/preview), else `published`. |
| `filter` | Field values, matched case-insensitively. An array matches any of its values. An array field matches when any element matches. A `Date` matches its ISO string. `id` filters by document id. `empty: ['summary']` matches documents without a value. |
| `search` | Case-insensitive substring over the collection's `search` fields. |
| `sort` | `{ field, direction? }`. Dates and numbers sort by value, others as strings. Default is id order. |
| `facets` | Fields to count over every matching document. |
| `limit`, `cursor` | Page size (default 50, max 1,000) and the previous page's `nextCursor`. |

Listing runs in memory over one revision's documents with the [`array()` Collection engine](/docs/source/server-api#collections-over-an-array). It needs no database index and works on every host. A cursor is bound to the revision and query, so it fails as stale after a publish or with another filter.

A draft with field issues lists and reads with `issues`, and `data` holds its stored values. On `published`, a document whose frontmatter no longer validates, for example after a field changed, is left out of `list()` with a warning. `get()` throws `CONTENT_INVALID` for it, naming each failing field. A file that does not parse is left out on every ref. `raw()` still returns its text, so a tool can show it, diff it with another ref, and save a fix with its `digest` as `ifDigest`.

```ts [server/utils/compare-refs.ts]
import content from '../content'

export async function compareRefs() {
  const posts = content.collection('posts')
  const [draft, published] = await Promise.all([posts.raw('hello', { ref: 'draft' }), posts.raw('hello')])
  return draft?.text === published?.text
}
```

A collection is also a read-only [Collection](/docs/source/server-api) over its published documents. It has no `authorize`, so add one before you serve it: `defineCollectionHandler({ ...posts, authorize: false })` serves published lists with field filters to anyone. Export the same object from `server/collections/` to get the generated route. Without `authorize`, the handler throws `SOURCE_R0035`.

### Save and remove

```ts fragment
const posts = content.collection('posts')
const draft = await posts.get('hello', { ref: 'draft' })
await posts.save('hello', { data: { title: 'Hello', date: '2026-10-14', tags: ['vue'] }, body: '# Hello' }, {
  ifDigest: draft?.digest ?? null,
  message: 'Rewrite the intro',
  metadata: { author: user.id },
})
await posts.remove('old-post')
```

| Option | Behavior |
| --- | --- |
| `ifDigest` | The `draft` digest you edited. `null` requires that the document does not exist yet. Omit it to overwrite the draft. |
| `ifPublishedDigest` | The `published` digest you reviewed, or `null` if absent. On the GitHub store, it replaces the document's publish base after you reapply your edit to the published version. A changed published ref refuses the save. `ifDigest` still protects the draft on its own. |
| `message` | Revision message. Defaults to one such as `Save posts/hello`. |
| `metadata` | JSON-safe revision metadata, such as the author. Content reserves the `content` key. |
| `session` | The caller's [session](/docs/content/editing-together) token. Its own edit lease does not block the write, which renews it. |
| `lease` | `'override'` writes even while another session holds the edit lease. Without it, the write fails with `CONTENT_LEASE_HELD`. |

Saving content equal to the draft keeps the draft revision, unless you pass `ifPublishedDigest` to record a reviewed base. A first save on an empty draft starts it from `published`, so no published file is lost.

### Conflicts

If another save moved the draft head, Content commits again on the new head. It fails with `WORKSPACE_CONFLICT` only when `ifDigest` no longer matches. `details` has `collection`, `id`, `path`, `ref: 'draft'`, `expected`, and `actual`. Reload, merge, and save with the new digest. With `ifPublishedDigest`, the published version must also match and stay at the checked revision until the commit, else the conflict names the published ref.

### Status

| `state` | Meaning |
| --- | --- |
| `draft` | Saved, never published. |
| `published` | The draft and the published version match. |
| `changed` | Published, with unpublished draft changes. |
| `deleted` | Removed from the draft, still published until the next `publish()`. |

`status(id)` returns `{ collection, id, state, draft, published, issues?, schedule?, conflict? }`. `issues` counts the draft's field issues. `draft` and `published` are the digests on each ref, or `null`. `schedule` is the document's [scheduled publish](/docs/content/scheduling#statuses), if any. It returns `null` when the document is on neither ref. An empty draft mirrors `published`, so before the first save `draft` equals `published`.

In a collection with [locales](/docs/content/configure#locales), `status()` and `status(id)` compare the source locale, and each entry has `locale` and `translations`, such as `{ es: 'stale', fr: 'missing' }`. Pass `{ locale }` to compare another locale: `status({ locale: 'es' })` or `status('guide', { locale: 'es' })`.

On the [GitHub store](/docs/cms/configure#github-store), `conflict: { base }` marks a document that both the draft and the published branch changed since the draft took it, for example with a Git commit. `base` is the digest the draft started from. `publish()` refuses the document until a save with `ifPublishedDigest` records the reviewed published version. `status()` shows it before anyone publishes.

### Publish

```ts [server/utils/publish.ts]
import content from '../content'

export async function publishAll() {
  await content.publish({ collection: 'posts', ids: ['hello'], message: 'Publish hello' })
  await content.publish()
}
```

| Option | Behavior |
| --- | --- |
| `collection` | Publish one collection. Omit to publish every collection. |
| `ids` | Publish only these documents. Requires `collection`. An id that exists on neither ref throws `CONTENT_NOT_FOUND`. |
| `expect` | `[{ collection, id, locale?, digest }]`: publish exactly these documents, and only if each draft digest still matches. `digest: null` expects the document deleted on the draft. Omit `id` for a singleton. `locale` defaults to the source locale of a collection with [locales](/docs/content/configure#locales). Cannot be combined with `collection` or `ids`. See [Publish what was reviewed](#publish-what-was-reviewed). |
| `ifHead` | Expected `published` head revision id, or `null` before the first publish. A different head throws `WORKSPACE_CONFLICT` with `details.ref` set to `published`. Without it, a concurrent publish is retried on the new head. |
| `message`, `metadata` | Revision message and JSON-safe metadata. |

`publish()` returns `{ revision, documents }`. `documents` lists each change as `{ collection, id, change }` with `add`, `update`, or `delete`, and `locale` in a collection with locales. Without `expect`, a collection with locales publishes every locale. `revision` is `null` when nothing differed from the draft. Files outside the collection paths are not published.

### Publish what was reviewed

`collection` and `ids` publish whatever the draft holds when `publish()` runs. A draft saved after a confirmation or approval would go out unreviewed. Confirm and approve flows must use `expect`: capture the draft digests the person saw, and pass them back.

```ts [server/utils/publish-reviewed.ts]
import content from '../content'

export async function publishReviewed() {
  const reviewed = (await content.collection('posts').status())
    .filter(document => document.state !== 'published')
    .map(({ collection, id, draft }) => ({ collection, id, digest: draft }))

  // ...show the changes and wait for confirmation or approval...

  await content.publish({ expect: reviewed, message: 'Publish reviewed posts' })
}
```

If any draft digest differs, `publish({ expect })` publishes nothing and throws `WORKSPACE_CONFLICT`. `details` is `{ ref: 'draft', documents }`, with one `{ collection, id, expected, actual }` per mismatch, where `actual` is the current digest or `null` if deleted. Review them and publish with the new digests. A draft that matches `published` is skipped. A concurrent publish of other documents retries and checks `expect` again. Add `ifHead` to reject any other publish.

### Revisions

```ts [server/utils/restore-post.ts]
import content from '../content'

export async function restorePreviousVersion() {
  const { revisions, cursor } = await content.revisions('posts', 'hello', { limit: 10 })
  const earlier = await content.collection('posts').get('hello', { revision: revisions[1].id })
  await content.collection('posts').restore('hello', revisions[1].id)
  return { earlier, cursor }
}
```

`revisions()` reads `draft` by default. Pass `ref: 'published'` for publishes. Each item is a Workspace revision with `id`, `createdAt`, `message`, and `metadata`. Content records `metadata.content.action` and `metadata.content.documents` on its own commits, and lists only those. One call scans at most 1,000 revisions and returns a `cursor` to continue.

Omit the document to list recent changes in all collections, for an activity feed. `metadata.content.documents` lists each revision's documents:

```ts [server/utils/activity.ts]
import content from '../content'

export async function recentPublishes() {
  const { revisions } = await content.revisions({ ref: 'published', limit: 20 })
  return revisions
}
```

### Access

```ts [server/api/posts/publish.post.ts]
import { createError, defineEventHandler } from 'h3'
import { withAuth } from 'vite-hub/auth/server'
import content from '../../content'

export default defineEventHandler(
  withAuth(async (event, { user }) => {
    if (!await content.can({ user, collection: 'posts', action: 'publish' }))
      throw createError({ statusCode: 403 })
    return await content.publish({ collection: 'posts' })
  }),
)
```

`can()` runs [`defineContent({ authorize })`](/docs/content/configure#access), and returns `false` without a policy. Pass the signed-in Auth user as `user`, or omit it for `null`. When acting for an Agent, also pass the Invocation's `actor`:

```ts fragment
await content.can({ user: authUser, actor, collection: 'posts', action: 'write', id: 'hello' })
```

An unknown collection, a `user` that is not an object or `null`, or an `actor` without `id` throws `CONTENT_R0008`.

### Comark refs

`content.getSource('posts')` is the collection's Comark Source over `published`. `getSource('posts').withRef('draft')` reads the draft. Only `draft` and `published` work.

### Preview

```ts fragment
await content.preview.enable(event, { maxAge: 900 }) // sets the cookie: { setCookie, expiresAt }
content.preview.disable(event)                       // clears it
await content.preview.run(event, () => posts.get('hello')) // draft when the event has a valid cookie
content.preview.active()                             // true with a valid preview cookie
await content.preview.sign({ collection: 'posts', id: 'hello', maxAge: 900 }) // a preview frame token for one document
content.preview.frame()                              // { collection, id, document? } in a preview frame
```

With a valid preview cookie, every Content read above uses `draft`. A preview frame reads its one document's draft through collection `get()` and `list()`, and `published` everywhere else. `?vitehub-content-published` reads `published` even with the cookie. See [Draft preview](/docs/content/preview) for the signing key, cookie, and caching.

## Field addresses

`contentField()` returns the `data-content-field` attribute for the element that renders a field. Page tools read it to find the document and field behind the text. [Comments](/docs/comments/configure#mark-content-fields) uses it to edit text in place and save a draft.

```vue
<h1 v-bind="contentField('about', 'hero.title')">{{ about.hero.title }}</h1>
<span v-bind="contentField('customers', customer.id, 'name')">{{ customer.data.name }}</span>
```

The address is `<collection>[:<id>]#<field.path>`, such as `about#hero.title` for a singleton or `customers:acme#name` for a document. `formatContentField()` throws a `TypeError` for a name or path the format cannot hold. `parseContentField()` returns `{ collection, id?, field }`, or `undefined`.
