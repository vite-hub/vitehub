---
title: Content configuration
description: Define read-only Sources and editable document collections with defineContent(), choose plugins, and set access.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Definition options

`defineContent(options)` takes read-only Sources, editable document collections, or both. Each Source and each collection becomes one Comark instance, composed with Comark's `contentHub()`. A single `source` becomes an instance named `default`.

| Option | Type | Description |
| --- | --- | --- |
| `source` | Content Source input | One read-only Source. Cannot be combined with `sources`. |
| `sources` | `Record<string, ContentSourceInput>` | Named read-only Sources. Each name becomes a Content instance. |
| `collections` | `Record<string, documents(...)>` | Editable Markdown collections. Each name becomes a Content instance that serves published documents. See [Document collections](#document-collections). |
| `workspace` | `string` | The Workspace that stores `collections`. Required with `collections`. It needs retained history. |
| `authorize` | `({ user, actor?, collection, action, id? }) => boolean \| Promise<boolean>` | Policy that Content surfaces evaluate through `content.can()`. See [Access](#access). |
| `plugins` | Comark Content plugins | Applied to each instance. Markdown parsing is built in. Add `json()`, `yaml()`, `media()`, `sql-query`, or `sqlite-full-text-search` plugins when you need them. |
| Other Comark options | `cache`, `hooks`, `markdown`, `logger`, `onError`, `baseURL` | Forwarded to each Comark Content instance. ViteHub sets `basePath` to `/api/content`. |

Plugin options are evaluated when the runtime is created. Recreate or rebuild the runtime to change them.

### Source inputs

| Input | Behavior |
| --- | --- |
| Source definition, such as `glob()` or `defineSource()` | Opens a new Reader for each load. Overlapping refreshes, fresh snapshots, and fresh document reads keep their selected revisions. |
| Registered Source name | Opens `useSource(name)` for each load. |
| Reader factory `() => reader` | Calls the factory for each load. |
| Explicit reader with `items()` | Keeps its caller-owned lifecycle and selected revision across refreshes. |
| Native Comark Source, such as `comark-content/sources/fs` | Keeps its own loading behavior. |

Each item's public path comes from its `path`, or from its key. Items need `content` or `data`. ViteHub serializes structured `data` as JSON before Comark parses it.

Use `contentSource(input, { prefix, schema })` to set Comark options for one Source. A direct adapter selects a Reader when `keys()` starts an enumeration. Its later `getItem()` calls use that Reader until the next enumeration. Pass the adapter through `defineContent()` to isolate overlapping loads.

## Document collections

Use a collection when people or Agents edit the content at runtime. Sources stay read-only. A collection stores Markdown files in a Workspace, validates their frontmatter, keeps every save as a draft revision, and serves only what you publish.

### Store the collection

Collections need a Workspace with retained history. Use the [Blob + Database Store](/docs/workspace/configure#blob-database-store): add its schema to a Database, then define the Workspace.

```ts [server/databases/content/config.ts]
import { defineDatabase } from 'vite-hub/database'
import { workspaceHistorySchema } from 'vite-hub/workspace/blob-database'

export default defineDatabase({ name: 'content', schema: workspaceHistorySchema })
```

```ts [server/workspaces/site.ts]
import { blob } from 'vite-hub/blob'
import { defineWorkspace } from 'vite-hub/workspace'
import { createBlobDatabaseWorkspaceStore } from 'vite-hub/workspace/blob-database'
import contentDatabase from '../databases/content/config'

export default defineWorkspace({
  store: createBlobDatabaseWorkspaceStore({
    blob: blob.store('content'),
    database: contentDatabase,
    workspace: 'site',
  }),
})
```

Enable [Database](/docs/database/configure), then run `vitehub db generate` and `vitehub db migrate` before the first save. A Workspace without retained history fails on first use with `CONTENT_R0007`.

### Define collections

```ts [server/content.ts]
import { defineContent, documents, optional } from 'vite-hub/content'
import { z } from 'zod'
import * as v from 'valibot'

export const content = defineContent({
  workspace: 'site',
  collections: {
    posts: documents({
      path: 'posts/**/*.md',
      fields: {
        title: z.string().min(1),
        date: z.coerce.date(),
        tags: z.array(z.string()).default([]),
        summary: optional(v.string()),
      },
    }),
  },
})
```

| `documents()` option | Type | Description |
| --- | --- | --- |
| `path` | `string` | Workspace glob for the collection's Markdown files. Use `*`, `**`, and `?`, and end with one extension, such as `posts/**/*.md`. The folder before the first wildcard is the collection folder. |
| `fields` | `Record<string, StandardSchema>` | One validator per frontmatter field. |
| `search` | `string[]` | Fields that `list({ search })` matches. Defaults to every string field plus the body. |

A document id is the file path below the collection folder, without the extension. `posts/hello.md` is `hello`, and `posts/2026/launch.md` is `2026/launch`. The Markdown body after the frontmatter is the document `body`.

### Fields

`fields` is a record, not one object schema, so each field can come from a different library. Zod 4 and Valibot object schemas reject validators from other libraries, such as a Blob `image()`; a record of fields accepts any [Standard Schema](https://standardschema.dev).

- **Typed data.** `data` takes each field's output type, so `date` is a `Date`. `save()` takes each field's input type.
- **Optional fields.** A field is optional when its validator accepts a missing value, as with `.optional()` or `.default()`. Wrap a validator that has no `.optional()` in `optional()` from `vite-hub/content`.
- **Stored values.** Saved frontmatter is YAML. Values go through a JSON round trip before validation, so a `Date` is stored as an ISO string. Use validators that accept the stored form, such as `z.coerce.date()` instead of `z.date()`.
- **Other keys.** Frontmatter keys without a field stay in the file and are left out of `data`.

### JSON Schema

`content.collection('posts').schema` is the frontmatter JSON Schema, built from each field's [Standard JSON Schema](https://standardschema.dev). The Console editor builds its form from it, and the Content Agent Capability builds its tool input from it. Comark gets the same schema narrowed to its subset.

| Field | JSON Schema |
| --- | --- |
| `z.string().min(1)` | `{ type: 'string', minLength: 1 }` |
| `z.coerce.date()` | `{ type: 'string', format: 'date-time' }` |
| `z.iso.date()` | `{ type: 'string', format: 'date', pattern }` |
| `toStandardJsonSchema(v.string())` | `{ type: 'string' }` |
| `v.string()` | `{}` |

Zod 4 schemas carry a Standard JSON Schema. Zod cannot represent a `Date`, so Content projects Zod date fields as the ISO `date-time` string they are stored as. Valibot schemas carry none: wrap them in `toStandardJsonSchema()` from `@valibot/to-json-schema`.

```ts [server/content.ts]
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

const fields = {
  title: toStandardJsonSchema(v.pipe(v.string(), v.minLength(1))),
  day: toStandardJsonSchema(v.pipe(v.string(), v.isoDate())),
}
```

A field whose JSON Schema is empty gets no form control or type hint, so `defineContent()` warns once per such field and names the collection and the field. The field still validates.

### Drafts and publishing

Content uses two [history refs](/docs/workspace/server-api#refs) in the Workspace:

- `draft`: every `save()`, `remove()`, and `restore()` commits one revision here.
- `published`: `content.publish()` copies the selected draft documents here in one revision.

`/api/content/**` serves only `published` documents and is read-only. Content adds no write routes. Write from server code, the Console, or the Content Agent Capability, or call the server API from your own route.

Each collection's Comark instance reads the `published` head. Content reads check the head first and refresh the instance when another process or host published, so every instance converges without a shared cache.

Saves that touch different documents never conflict: when another save moves the draft head, Content commits again on the new head. Pass `ifDigest` to reject a save when the same document changed; see [Server API](/docs/content/server-api#conflicts).

### Validation for every writer

Content registers a `vitehub.content` Workspace plugin with a `write:validate` hook for each collection path. Any writer that puts an invalid file there fails with `CONTENT_INVALID`: Workspace `fs` writes, Sessions, Agents, and history commits on any ref. `save()` also validates before it commits and reports each failing field.

The hook is installed when `server/content.ts` loads. The generated Content route and any import of `content` load it. `publish()` validates again, so a file written before the hook was installed cannot reach `published` unless it is valid.

### Sources and collections together

A runtime can combine read-only `sources` with `collections`. Names share one namespace, so a collection cannot reuse a Source name. Use Sources for content you change through code, such as files in the repository, and collections for content edited at runtime.

## Access

`authorize` decides what a user may do with a collection. Surfaces call it through `content.can()`. The Console content editor and the Content Agent Capability use it.

```ts [server/content.ts]
export const content = defineContent({
  workspace: 'site',
  collections: { posts },
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

| Field | Value |
| --- | --- |
| `user` | The signed-in Auth user, or `null`. The Console passes the Console user. An Agent passes the Auth user its Actor stands for, or `null`. |
| `actor` | The Actor of the Agent Invocation when an Agent makes the call, such as the Content Agent Capability. `undefined` otherwise. |
| `collection` | The collection name. |
| `action` | `read` for drafts, `write` for save, remove, and restore, or `publish`. |
| `id` | The document, when the action targets one. |

One policy covers people and Agents. Check `actor` to give Agents less than the user they act for:

```ts [server/content.ts]
authorize: ({ user, actor, action }) => {
  if (user?.role !== 'editor') return false
  return actor === undefined || action !== 'publish'
},
```

Without `authorize`, `content.can()` returns `false` for every action. Published documents are public through `/api/content/**`; `read` covers drafts.

The runtime methods, such as `save()` and `publish()`, are trusted server API. They do not call `authorize`. Check `content.can()` yourself before you call them from a route that acts for a user.

## Providers

Content has no hosted provider. Comark Content stores its query and search index in the database that you pass to a plugin. Collections list, filter, sort, and search in memory, so they need no index plugin.

| Database | Import | Use |
| --- | --- | --- |
| Node SQLite | `comark-content/database/sqlite-node` | Node runtimes with built-in SQLite. |
| SQLite WASM | `comark-content/database/sqlite-wasm` | Runtimes where Node SQLite is unavailable. |

The `vitehub()` Vite plugin generates the Content route for every preset. The Nuxt module installs the same behavior. Libraries that use owner packages get it from `hubSource()` in `@vite-hub/source/vite`. Each Source loader must also work on the host. For example, `glob()` reads the local file system at runtime.

See [Limits and errors](/docs/content/limits-and-errors) before running Content in production.
