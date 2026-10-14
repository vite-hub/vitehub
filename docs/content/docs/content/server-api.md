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
| `documents`, `optional` from `vite-hub/content` | Define an editable document collection and mark a field optional. |
| `contentSource` from `vite-hub/content` | Adapt one Source and set Comark options such as `prefix` and `schema`. |
| `defineContentHandler` from `vite-hub/content` | Adapt a Content runtime to an H3 or Nitro route in another server. |
| `createContentClient`, `defineContentClientPlugin` from `vite-hub/content/client` | Use or extend the typed Comark Content client. |
| `comark-content/database/*`, `comark-content/plugins/*`, `comark-content/sources/*` | Comark databases, parser and search plugins, and native Comark Sources. |

Libraries can install `@vite-hub/content` and use the matching `@vite-hub/content` and `@vite-hub/content/client` imports.

## Runtime API

`defineContent()` returns a Comark Content hub with ViteHub adapters for named Sources and collections.

| Method | Behavior |
| --- | --- |
| `content.get(path)` | Returns one parsed document by public path, such as `/guide`. |
| `content.list(names?)` | Lists documents. Accepts one instance name or an array. |
| `content.navigation(names?)` | Builds one navigation tree across the selected instances. |
| `content.search(names, query, options?)` | Runs full-text search across the named instances. Requires the `sqlite-full-text-search` plugin. |
| `content.init()` | Loads and parses every instance. |
| `content.getSource(name?)` | Returns the Comark Source for one instance. Defaults to `default`. |
| `content.handler(request)` | Answers a Web `Request`. The generated route calls it through `defineContentHandler()`. |

```ts
await content.get('/guide')
await content.navigation(['docs'])
await content.search(['docs'], 'runtime')
```

Methods that plugins add, such as SQL queries, stay available on the returned runtime. A collection instance serves its published documents at public paths that follow the Workspace path, so `posts/hello.md` is `/posts/hello`. `get`, `list`, `navigation`, `search`, and `handler` first check the `published` head and refresh collection instances that are behind. Plugin methods read the last refreshed state.

### Cache

Comark Content owns parsed document cache entries. ViteHub routes each cache call to the instance that owns it.

| Method | Behavior |
| --- | --- |
| `content.cache.refresh(name)` | Reloads one instance from its Source. |
| `content.cache.invalidate(key)`, `content.cache.expire(key)` | Invalidates or expires one cache entry. Keys start with the instance name, such as `docs:guide/index.md`. |
| `content.cache.get(key)`, `content.cache.set(key, value)` | Reads or writes one cache entry. |
| `content.cache.keys(name?)`, `content.cache.clear(name?)` | Lists or clears entries for one instance or all instances. |
| `content.cache.snapshot(name, options?)` | Refreshes one instance and builds a Comark cache artifact. |

### Client

`createContentClient()` calls `/api/content` by default. Pass `instances` to search specific named Sources. Client plugins, such as `comark-content/plugins/sqlite-full-text-search/client`, add methods that match server plugins.

## Collections

`content.collection(name)` opens a collection from [`defineContent({ collections })`](/docs/content/configure#document-collections). These methods are trusted server API: they do not call `authorize`. Check [`content.can()`](#access) first when a route acts for a user.

```ts [server/api/posts/[id].put.ts]
import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { content } from '../../content'

export default defineEventHandler(async (event) => {
  const { data, body, digest } = await readBody(event)
  return await content.collection('posts').save(getRouterParam(event, 'id')!, { data, body }, { ifDigest: digest })
})
```

| Method | Behavior |
| --- | --- |
| `content.collections()` | Every collection in definition order. Each one is the same object `content.collection(name)` returns, with `name`, `path`, `fields`, and `schema`. Empty without `collections`. |
| `posts.list(options?)` | Lists documents without their body. Returns `{ items, nextCursor, total, facets? }`. Reads `published` unless `ref: 'draft'`. |
| `posts.get(id, options?)` | Returns one document, or `null`. Reads `published` unless `ref: 'draft'`, or one history revision with `revision`. |
| `posts.raw(id, options?)` | Returns the stored file as `{ collection, id, path, text, digest, revision }`, or `null`, without parsing or validating it. Takes the same `ref` or `revision` as `get()`. |
| `posts.save(id, { data, body }, options?)` | Validates the fields and commits the file to `draft`. Returns the saved document. |
| `posts.remove(id, options?)` | Deletes the document from `draft`. It stays published until the next `publish()`. |
| `posts.restore(id, revision, options?)` | Saves the document as it was in an earlier revision as the new draft. |
| `posts.status(id?)` | Compares `draft` and `published` for one document, or for every document when you omit `id`. |
| `posts.name`, `posts.path`, `posts.fields` | The collection name, its glob, and its field names in definition order. |
| `posts.schema` | The frontmatter [JSON Schema](/docs/content/configure#json-schema). |
| `content.publish(options?)` | Copies draft documents to `published` in one revision. Pass `expect` to publish exactly what was reviewed. |
| `content.revisions(collection, id, options?)` | Revisions that saved, removed, restored, or published one document, newest first. |
| `content.can({ user?, actor?, collection, action, id? })` | Evaluates `authorize`. Returns `false` when no policy is defined. |

A document is `{ collection, id, path, data, body, digest, revision, updatedAt }`. `path` is the Workspace file, `data` holds each field's validated output, and `digest` is the SHA-256 of the file bytes. `revision` is the history revision the document was read from.

`updatedAt` is when the document last changed on the ref it was read from: the `createdAt` of the newest revision on that ref that added or changed its file. On `published`, that is the publish that last changed it. On `draft`, it is the last save or restore, or the revision that started the draft from `published`. Content finds it by walking the ref back from the revision it read, once per revision per runtime, and stops at an earlier answer it already has. It is `null` when the change is older than the 5,000 revisions one walk scans.

### List documents

```ts
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
```

| Option | Behavior |
| --- | --- |
| `ref` | `published` (default) or `draft`. |
| `filter` | Field values, matched case-insensitively. An array matches any of its values, and an array field matches when any element matches. A `Date` matches its ISO string. `id` filters by document id. `empty: ['summary']` matches documents without a value. |
| `search` | Case-insensitive substring over the collection's `search` fields. |
| `sort` | `{ field, direction? }`. Dates and numbers sort by value, other values as strings. Without `sort`, documents are in id order. |
| `facets` | Fields to count over every matching document. |
| `limit`, `cursor` | Page size (default 50, at most 1,000) and the previous page's `nextCursor`. |

Listing runs in memory over the documents of one revision, with the [`array()` Collection engine](/docs/source/server-api#collections-over-an-array). It needs no database index and works on every host. A cursor is bound to the revision and the query, so it fails as stale after a publish or with another filter.

A document whose frontmatter no longer validates, for example after a field changed, is left out of `list()` with a warning. `get()` throws `CONTENT_INVALID` for it with each failing field. `raw()` still returns its text, so a tool can show it, diff it against another ref, and save a repaired version with its `digest` as `ifDigest`.

```ts
const posts = content.collection('posts')
const [draft, published] = await Promise.all([posts.raw('hello', { ref: 'draft' }), posts.raw('hello')])
```

A collection is also a read-only [Collection](/docs/source/server-api) over its published documents. Pass it to `defineCollectionHandler()` or export it from `server/collections/` to serve published listings with field filters.

### Save and remove

```ts
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
| `ifDigest` | The document digest you edited on `draft`. `null` requires that the document does not exist yet. Omit it to overwrite the draft. |
| `message` | Revision message. Defaults to a message such as `Save posts/hello`. |
| `metadata` | JSON-safe revision metadata, such as the author. Content reserves the `content` key. |

Saving content identical to the draft keeps the current draft revision. A first save on an empty draft starts the draft from `published`, so no published file is lost.

### Conflicts

Saves of different documents never conflict. When another save moved the draft head, Content commits again on the new head. A save fails with `WORKSPACE_CONFLICT` only when `ifDigest` no longer matches this document. The error `details` carry `collection`, `id`, `path`, `ref: 'draft'`, `expected`, and `actual`. Load the document again, merge, and save with the new digest.

### Status

| `state` | Meaning |
| --- | --- |
| `draft` | Saved, never published. |
| `published` | The draft and the published version match. |
| `changed` | Published, with unpublished draft changes. |
| `deleted` | Removed from the draft, still published until the next `publish()`. |

`status(id)` returns `{ collection, id, state, draft, published }`, where `draft` and `published` are the document digests on each ref or `null`. It returns `null` when the document exists on neither ref. An empty draft mirrors `published`, so before the first save `draft` equals `published`.

### Publish

```ts
await content.publish({ collection: 'posts', ids: ['hello'], message: 'Publish hello' })
await content.publish()
```

| Option | Behavior |
| --- | --- |
| `collection` | Publish one collection. Omit to publish every collection. |
| `ids` | Publish only these documents. Requires `collection`. An id that exists on neither ref throws `CONTENT_NOT_FOUND`. |
| `expect` | `[{ collection, id, digest }]`: publish exactly these documents, and only if each draft digest still matches. `digest: null` expects the document deleted on the draft. Cannot be combined with `collection` or `ids`. See [Publish what was reviewed](#publish-what-was-reviewed). |
| `ifHead` | Expected `published` head revision id, or `null` before the first publish. A different head throws `WORKSPACE_CONFLICT` with `details.ref` set to `published`. Without it, a concurrent publish is retried on the new head. |
| `message`, `metadata` | Revision message and JSON-safe metadata. |

`publish()` returns `{ revision, documents }`. `documents` lists each change as `{ collection, id, change }` with `add`, `update`, or `delete`. `revision` is `null` when nothing differed from the draft. Files outside the collection paths are not published.

### Publish what was reviewed

`collection` and `ids` publish whatever the draft holds when `publish()` runs. A draft saved between a confirmation or an approval and the publish would go out unreviewed. Confirm and approve flows must pin the publish with `expect` instead: capture the draft digests that the person or approver saw, and pass them back.

```ts
const reviewed = (await content.collection('posts').status())
  .filter(document => document.state !== 'published')
  .map(({ collection, id, draft }) => ({ collection, id, digest: draft }))

// ...show the changes and wait for confirmation or approval...

await content.publish({ expect: reviewed, message: 'Publish reviewed posts' })
```

`publish({ expect })` publishes nothing and throws `WORKSPACE_CONFLICT` when any draft digest differs. `details` are `{ ref: 'draft', documents }`, with one `{ collection, id, expected, actual }` per mismatched document, where `actual` is the current draft digest or `null` for a deleted draft. Review those documents again and publish with their new digests. A document whose draft already matches `published` is skipped. A concurrent publish of other documents is retried, and `expect` is checked again each time. Combine `expect` with `ifHead` to also reject any other publish.

### Revisions

```ts
const { revisions, cursor } = await content.revisions('posts', 'hello', { limit: 10 })
const earlier = await content.collection('posts').get('hello', { revision: revisions[1].id })
await content.collection('posts').restore('hello', revisions[1].id)
```

`revisions()` reads the `draft` ref by default. Pass `ref: 'published'` for publishes. Each item is a Workspace revision with `id`, `createdAt`, `message`, and `metadata`. Content records `metadata.content.action` and `metadata.content.documents` on its own commits, and lists only those. Commits made outside Content are not attributed to a document. One call scans at most 1,000 revisions and returns a `cursor` to continue.

### Access

```ts
if (!await content.can({ user, collection: 'posts', action: 'publish' }))
  throw createError({ statusCode: 403 })
await content.publish({ collection: 'posts' })
```

`can()` evaluates [`defineContent({ authorize })`](/docs/content/configure#access) and returns `false` without a policy. Pass the signed-in Auth user as `user`, or omit it for `null`. A surface that acts for an Agent also passes the Invocation's `actor`:

```ts
await content.can({ user: authUser, actor, collection: 'posts', action: 'write', id: 'hello' })
```

An unknown collection, a `user` that is not an object or `null`, or an `actor` without an `id` throws `CONTENT_R0008`.

### Comark refs

`content.getSource('posts')` is the collection's Comark Source over `published`. `getSource('posts').withRef('draft')` reads the draft. Content accepts only `draft` and `published`.
