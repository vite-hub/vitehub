---
title: Content configuration
description: Define read-only Sources and editable document collections with defineContent(), choose plugins, and set access.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Definition options

`defineContent(options)` takes read-only Sources, editable collections, or both. Each one becomes a Comark instance, joined with Comark's `contentHub()`. A single `source` becomes the instance `default`.

| Option | Type | Description |
| --- | --- | --- |
| `source` | Content Source input | One read-only Source. Not with `sources`. |
| `sources` | `Record<string, ContentSourceInput>` | Named read-only Sources, one instance each. |
| `collections` | `Record<string, documents(...) \| singleton(...)>` | Editable collections and singletons in Markdown, JSON, or YAML. Each is an instance that serves published documents. See [Document collections](#document-collections) and [Singletons and data files](#singletons-and-data-files). |
| `extends` | `cms` or `[cms, { ... }]` | Preset that stores `collections` with no setup. See [CMS options](/docs/cms/configure#options). Not with `workspace`. |
| `workspace` | `string` | Your own Workspace for `collections`. Required with `collections` unless `extends` sets it. It needs retained history. |
| `authorize` | `({ user, actor?, collection, action, id? }) => boolean \| Promise<boolean>` | Access policy that surfaces check with `content.can()`. See [Access](#access). |
| `live` | `'auto' \| false` | Live co-editing of Markdown. `auto` (default) turns it on when Realtime is on and the host has a room authority. See [Live editing](/docs/content/editing-together#live-editing). |
| `seo` | `{ site?, sitemap?, robots? }` | `/sitemap.xml` and `/robots.txt` from collections and Sources with a `url`. See [Sitemap and robots.txt](/docs/content/seo#sitemap-and-robotstxt). |
| `plugins` | Comark Content plugins | Used by each instance. Markdown parsing is built in. Add `json()`, `yaml()`, `media()`, `sql-query`, or `sqlite-full-text-search` as needed. A Comark parse plugin here throws `CONTENT_R0006`. |
| `markdown` | Comark parser options | Used by each instance. Put Comark parse plugins, such as `comark-knap`, in `markdown.plugins`. |
| Other Comark options | `cache`, `hooks`, `logger`, `onError`, `baseURL` | Passed to each instance. ViteHub sets `basePath` to `/api/content`. |

Plugin options are read once. Rebuild the runtime to change them.

### Source inputs

| Input | Behavior |
| --- | --- |
| Source definition, such as `glob()` or `defineSource()` | Opens a new Reader per load. Overlapping refreshes, snapshots, and document reads keep their selected revisions. |
| Registered Source name | Opens `useSource(name)` for each load. |
| Reader factory `() => reader` | Calls the factory for each load. |
| Explicit reader with `items()` | Keeps its caller-owned lifecycle and selected revision across refreshes. |
| `glob()` from `vite-hub/source` | Serves project files, such as `glob('content/docs/**/*.md')`. A build bundles them, so every host serves them. See [Hosts without a file system](/docs/source/configure#hosts-without-a-file-system). |
| Native Comark Source, such as `comark-content/sources/fs` | Keeps its own loading behavior. |

An item's public path is its `path`, or its key. Items need `content` or `data`. ViteHub turns structured `data` into JSON before Comark parses it.

`contentSource(input, { prefix, schema })` sets Comark options for one Source. Add `url`, such as `'/:id'`, to list its documents in the sitemap. See [Source URLs](/docs/content/seo#source-urls). A direct adapter picks a Reader when `keys()` starts an enumeration, and later `getItem()` calls use it until the next one. Pass the adapter through `defineContent()` to keep overlapping loads apart.

## Document collections

Use a collection when people or Agents edit content at runtime. A collection stores files in a Workspace (versioned file storage), validates their fields, keeps each save as a draft revision, and serves only what you publish. Files are Markdown with frontmatter, or [JSON or YAML](#singletons-and-data-files).

### Store the collection

Collections need a Workspace with retained history. The [CMS](/docs/cms) preset, `defineContent({ extends: cms })`, sets it up at build time. It turns on Workspace, Database, and Blob, adds a `content` Workspace on the [Blob + Database Store](/docs/workspace/configure#blob-database-store), and adds the history tables and the [Editing together](/docs/content/editing-together) `contentSessionsSchema` table to your Database (the implicit `default` Database if you define none).

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  collections: { posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }) },
})
```

Run `vitehub database generate` and `vitehub database migrate` before the first save. ViteHub needs no feature settings for the preset.

To use your own Workspace, pass its name as `workspace` instead of `extends`. Its Store must keep history, such as the Blob + Database Store with `workspaceHistorySchema` in a Database Definition. For presence and edit leases, add `contentSessionsSchema` from `vite-hub/content/database` to that Database. A Workspace without retained history fails on first use with `CONTENT_R0007`.

### Define collections

```ts [server/content.ts]
import { defineContent, optional } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'
import * as v from 'valibot'

export default defineContent({
  extends: cms,
  collections: {
    posts: documents({
      path: 'posts/**/*.md',
      url: '/blog/:id',
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
| `path` | `string \| string[]` | Workspace glob for the files. Use `*`, `**`, and `?`, and end with one extension, such as `posts/**/*.md` or `authors/*.json`. The folder before the first wildcard is the collection folder. The extension sets the [format](#data-files). A list reads [several folders](#several-folders). With `locales`, `{locale}` marks the locale folder. |
| `locales` | `string[]` | Locales of a [translated collection](#locales), such as `['en', 'es']`. The first one is the source locale. |
| `fields` | `Record<string, StandardSchema>` | One validator per frontmatter field. |
| `label` | `string \| { singular, plural }` | Display name, such as `'Posts'`. Pass `{ singular: 'Person', plural: 'People' }` for irregular plurals, so the Console shows **New person**. Defaults to the collection name in title case. |
| `titleField` | `string` | The string field that names a document in lists, search, and the editor title. Defaults to the first string field among `title`, `name`, `label`, and `heading`, then the first required string field. |
| `search` | `string[]` | Fields that `list({ search })` matches. Defaults to all string fields plus the body. |
| `components` | `Record<string, DocumentComponent>` | Comark components that bodies can use, keyed by tag, such as `alert` for `::alert`. The Console editor offers them in its `/` menu. Each takes `kind` (`block` or `inline`, default `block`), `label`, `description`, and `props` as `{ type: 'string' \| 'number' \| 'boolean' \| 'json' \| 'image' \| 'file', default? }`. An `image` or `file` prop opens the Media picker of `image()` and `file()` fields, limited to `store` when set. It stores the file as a string: its served URL, or its Blob pathname if the store is not served. Content stores the Markdown as written and does not check component use. |
| `url` | `string \| ({ id, data }) => string \| null` | Each document's public URL, such as `'/blog/:id'`. Reads return it as `document.url`. Sitemaps and canonical links use it, and [`content.resolve(path)`](#find-the-document-of-a-page) maps a page back to its document. See [Document URLs](/docs/content/seo#document-urls). |
| `editing` | `{ lease?: boolean }` | `lease: false` lets several sessions edit a document at once. By default, one session at a time holds the edit lease. See [Editing together](/docs/content/editing-together#opt-out-per-collection). |

A document id is the file path below the collection folder, without extension: `posts/hello.md` is `hello`, `posts/2026/launch.md` is `2026/launch`. The Markdown after the frontmatter is the `body`.

### Several folders

Pass a list of globs when one collection's documents are in several folders. All globs use one extension.

```ts [server/content.ts] fragment
pages: documents({
  path: ['content/guides/**/*.md', 'content/news/*.md'],
  fields: { title: z.string() },
})
```

The Console's new-document form offers each glob's folder and builds the path there. An id is the path below the folder all globs share, without extension: `content/news/launch.md` is `news/launch`. With no shared folder, the id is the whole path without extension (`posts/a.md` is `posts/a`). Saving an id that no glob matches throws `CONTENT_R0008`. If globs of two collections can match the same file, `defineContent()` throws `CONTENT_R0006`. Content lists only each glob's folder when it reads a revision, so it skips other files in a large repository.

::warning
Adding a glob can change existing ids. Ids are relative to the folder all globs share, so a glob in another folder moves that folder up: `posts/**/*.md` has ids like `hello`, but `['posts/**/*.md', 'news/*.md']` has ids like `posts/hello`. Schedules, saved `expect` entries, and links with ids then point at other documents. Ids stay the same when the new glob is inside the current folder, such as `['posts/**/*.md', 'posts/archive/**/*.md']`. Otherwise, change the collection `url` so URLs stay the same, publish or cancel pending schedules first, and expect each document's history under its new id.
::

### Find the document of a page

`content.resolve(path)` finds the document a page shows, for example for an Edit button. It returns `{ collection, id }`, or `null`.

```ts [server/utils/edit-target.ts]
import content from '../content'

export async function editTarget() {
  return await content.resolve('/blog/hello?utm=x')
  // { collection: 'posts', id: 'hello' }
}
```

A collection maps documents to paths with its [`url`](/docs/content/seo#document-urls). A document with `url: null` has no page. Without `url`, the path is `/` plus the id, without a trailing `/index`: `guides/index` is `/guides`, and `index` is `/`. Query strings, hashes, and trailing slashes are ignored. If two collections give the same path, the first defined wins. The path is percent-decoded, so `/caf%C3%A9` finds `café`. `resolve()` reads `published`, or `draft` in a preview request. Pass `{ ref: 'draft' }` to include unpublished documents.

Content builds the path map once per ref revision, so later calls are lookups. A pattern with only `:id`, such as `'/blog/:id'`, reads no documents. A `url` function or a field pattern reads what `list()` reads, so on `published` an invalid document does not resolve. A `url` that throws skips that document, with one warning per collection. Singletons do not resolve.

### Locales

Set `locales` to keep one document in several languages. The first locale is the source locale: you write it, and the other locales are translations of it. `{locale}` in the path marks the folder of each locale.

```ts [server/content.ts] fragment
docs: documents({
  path: 'docs/{locale}/**/*.md',
  locales: ['en', 'es'],
  url: '/docs/:id',
  fields: { title: z.string() },
})
```

A document keeps its id in every locale: `guide` is `docs/en/guide.md` in English and `docs/es/guide.md` in Spanish. `{locale}` must be a whole folder before the first wildcard, and with several globs, all of them must share the folder that holds it.

```ts fragment
const docs = content.collection('docs')
await docs.save('guide', { data: { title: 'Guide' }, body: 'Hello.' })
const english = await docs.get('guide', { ref: 'draft', locale: 'es' }) // { locale: 'en', fallback: true, source: { path, digest }, ... }: no translation yet
const spanish = await docs.save('guide', { data: { title: 'Guía' }, body: 'Hola.' }, { locale: 'es', sourceDigest: english.source.digest })
spanish.derivedFrom // { path: 'docs/en/guide.md', digest: 'sha256-…' }
await docs.status('guide') // { locale: 'en', translations: { es: 'current' }, ... }
```

- **Reads.** `get()`, `raw()`, and `list()` take `locale` and default to the source locale. When a locale has no translation of a document, `get()` and `list()` return the source locale version with `locale` set to the source locale and `fallback: true`. `raw()` returns `null`. `get()` also returns `source: { path, digest }`, the source locale version on the same ref. Its `digest` is `sha256-` and the hex SHA-256 of the file bytes, the form `derivedFrom` records.
- **Saves.** `save()`, `remove()`, and `restore()` take `locale` in their options. A save in another locale writes `derivedFrom: { path, digest }` into the file, as [Workspace lineage](/docs/workspace/server-api#derived-files) records it. Pass `sourceDigest`, the `source.digest` of the read you translated: the translation then records that version, and it is `stale` when the source changed between your read and your save. Without `sourceDigest`, an existing translation keeps its `derivedFrom`, so a typo fix does not mark a stale translation current, and a new translation records the source locale version on the draft at save time. `derivedFrom` is a reserved key, so a localized collection cannot have a field with that name, and Content ignores it in `data`.
- **Status.** `status()` compares the source locale by default. Each source locale document on the draft has `translations`, such as `{ es: 'stale' }`. A translation is `current` when its `derivedFrom` names the source version on the draft, `stale` when the source changed since, when the translation has no `derivedFrom`, or when its `derivedFrom` names another file than the source locale file of the same id, and `missing` when the locale has no file for the document. `status({ locale: 'es' })` compares the Spanish files themselves. `vitehub content status` prints stale and missing translations next to each document.
- **Publish.** `publish()` and `publish({ collection, ids })` publish every locale. An id that only a translation has publishes that translation. `publish({ expect })` entries take `locale`. `schedule()` publishes source locale documents only.
- **URLs.** A `url` pattern without `:locale` puts `/<locale>` before the URL of every locale but the source locale: `/docs/guide` and `/es/docs/guide`. Write `:locale` in the pattern to place it yourself, such as `'/:locale/docs/:id'`. A `url()` function receives `locale`. A read in a locale without a translation carries the URL of the requested locale. `content.resolve()` returns `{ collection, id, locale }`, and resolves the URL of a missing translation too, so the page can show the fallback.
- **Agents.** The [Agent Capability](/docs/content/agent-capability#translations) lists missing and stale translations and saves them with `locale`.

#### Pages in each locale

A catch-all page serves every locale with the calls a page already makes. `content.resolve(path)` gives the document and the locale of the path, and `get(id, { locale })` reads that locale:

```ts [server/api/page.get.ts] fragment
import { defineEventHandler, getQuery, HTTPError } from 'h3'
import content from '../content'

export default defineEventHandler(async (event) => {
  const page = await content.resolve(String(getQuery(event).path))
  if (page?.collection !== 'docs') throw new HTTPError({ status: 404 })
  return await content.collection('docs').get(page.id, { locale: page.locale })
})
```

```vue [pages/[...slug].vue]
<script setup lang="ts">
import { contentHead } from 'vite-hub/content/client'

const route = useRoute()
const { data: page } = await useFetch('/api/page', { query: { path: route.path } })
useHead(computed(() => contentHead(page.value, { site: { url: 'https://vitehub.dev' } })))
</script>

<template>
  <p v-if="page?.fallback">This page is not translated yet. It shows the English version.</p>
  <h1>{{ page?.data.title }}</h1>
</template>
```

`/es/docs/guide` shows the Spanish document, and `/docs/guide` the English one. Before a translation exists, `/es/docs/guide` shows the English document with `fallback: true`. In a collection with `url`, `get()` also returns `alternates`: the URL of each locale that has its own version, source locale first, such as `[{ locale: 'en', url: '/docs/guide' }, { locale: 'es', url: '/es/docs/guide' }]`. Use it for a language switcher. [`contentHead()`](/docs/content/seo#pages-in-several-locales) turns `locale` and `alternates` into `<html lang>`, `hreflang` links, and the canonical link.

The [Console editor](/docs/content/console#translations) switches between locales and shows the state of each translation. Edit leases and live rooms belong to the source locale document, so a translation save does not wait for the person who edits the source.

### Fields

`fields` is a record, not one object schema, so each field can come from a different library. Zod 4 and Valibot object schemas reject other libraries' validators, such as `image()`. A record accepts any [Standard Schema](https://standardschema.dev) as written.

`vite-hub/content` exports every field helper: `image()` and `file()` for a [Blob reference](/docs/blob/server-api#blob-reference-schemas) (also exported by `vite-hub/blob`), `seo()`, and `optional()`. The Workspace `file()` mount loader from `vite-hub/workspace` is a different helper. To use both, rename one import, such as `import { file as fileField } from 'vite-hub/content'`.

- **Typed data.** `data` has each field's output type, so `date` is a `Date`. `save()` takes the input type.
- **Optional fields.** A field is optional when its validator accepts a missing value, as with `.optional()` or `.default()`. Wrap a validator without `.optional()` in `optional()` from `vite-hub/content`.
- **Stored values.** Saved frontmatter is YAML. Values go through a JSON round trip before validation, so a `Date` is stored as an ISO string. Use validators that accept the stored form, such as `z.coerce.date()`, not `z.date()`. Nested objects and lists are YAML blocks, one value per line, so a diff shows what changed.
- **Other keys.** Frontmatter keys without a field stay in the file and are left out of `data`.

### Singletons and data files

Some content is one document, not a list: site settings, a home page, a footer. Define it with `singleton()` and a file path in `collections`. It gets the same drafts, publishing, history, validation, and access.

```ts [server/content.ts]
import { defineContent, image, optional } from 'vite-hub/content'
import { documents, singleton } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  workspace: 'site',
  collections: {
    settings: singleton({
      path: 'settings.json',
      fields: {
        title: z.string().min(1),
        description: z.string().max(160).optional(),
        socialImage: optional(image()),
        social: z.array(z.url()).default([]),
      },
    }),
    authors: documents({
      path: 'authors/*.yaml',
      fields: { name: z.string(), bio: z.string().optional() },
    }),
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

ViteHub has no settings schema. These fields are an example. Define the ones your site reads.

| `singleton()` option | Type | Description |
| --- | --- | --- |
| `path` | `string` | Workspace path of one file, such as `settings.json`, `config/site.yaml`, or `pages/home.md`, without wildcards. The extension sets the [format](#data-files). |
| `fields` | `Record<string, StandardSchema>` | One validator per field, as in `documents()`. |
| `url` | `string \| ({ id, data }) => string \| null` | The document's public URL, such as `'/'`. Omit it for data without a page, such as settings. |
| `editing` | `{ lease?: boolean }` | As in `documents()`. |

The id is the file name without extension: `settings.json` is `settings`. You rarely need it, because singleton methods work without an id.

```ts [server/utils/settings.ts]
import content from '../content'

export async function renameSite() {
  const settings = content.collection('settings')

  await settings.get()                       // published settings, or null before the first publish
  const draft = await settings.save({ data: { title: 'ViteHub' } })
  await content.publish({ expect: [{ collection: 'settings', digest: draft.digest }] })
  await settings.status()                    // { state: 'published', ... }
}
```

`content.collection('settings')` has `kind: 'singleton'` and `id`. A collection has `kind: 'documents'`. Generic code, such as a tool, can pass the id as for a collection. Any other id throws `CONTENT_R0008`. See [Singletons](/docs/content/server-api#singletons) for every method.

#### Data files

The file extension sets the format:

| Extension | Format | Stored as | Body |
| --- | --- | --- | --- |
| `.json` | `json` | One JSON object, indented by two spaces. | None. |
| `.yaml`, `.yml` | `yaml` | One YAML mapping, in block style. | None. |
| Any other, such as `.md` | `markdown` | YAML frontmatter above a Markdown body. | `body`. |

A JSON or YAML document is only its fields. `body` is always empty, and `save()` rejects a non-empty one with `CONTENT_INVALID`. A file whose root is not one object, such as a JSON array, fails validation for every writer. Each save renders the whole file from the values in field order, so equal values give equal bytes, with each nested value on its own line.

`/api/content` serves published data files like Markdown, at a path that follows the Workspace path: `settings.json` is `/api/content/get/settings`, and `authors/ada.yaml` is `/api/content/get/authors/ada`. Content installs Comark's JSON and YAML parsers for them.

### JSON Schema

`content.collection('posts').schema` is the frontmatter JSON Schema, built from each field's [Standard JSON Schema](https://standardschema.dev). The Console editor builds its form from it, and the Agent Capability its tool input. Comark gets it narrowed to its subset.

| Field | JSON Schema |
| --- | --- |
| `z.string().min(1)` | `{ type: 'string', minLength: 1 }` |
| `z.coerce.date()` | `{ type: 'string', format: 'date-time' }` |
| `z.iso.date()` | `{ type: 'string', format: 'date', pattern }` |
| `v.pipe(v.string(), v.minLength(1))` | `{ type: 'string', minLength: 1 }` |
| `v.pipe(v.string(), v.isoDate())` | `{ type: 'string', format: 'date' }` |

Zod 4 schemas have a Standard JSON Schema. Zod cannot represent a `Date`, so Content shows Zod date fields as the stored ISO `date-time` string. Valibot schemas have none, so Content converts them with `@valibot/to-json-schema`, like Agent tools. Pass them as they are:

```ts [server/content.ts]
import * as v from 'valibot'

const fields = {
  title: v.pipe(v.string(), v.minLength(1)),
  day: v.optional(v.pipe(v.string(), v.isoDate())),
}
```

A field with an empty JSON Schema gets no form control or type hint, so `defineContent()` warns once per field, naming the collection and field. It still validates.

### Drafts and publishing

Content uses two [history refs](/docs/workspace/server-api#refs) in the Workspace:

- `draft`: each `save()`, `remove()`, and `restore()` commits one revision here.
- `published`: `content.publish()` copies the selected drafts here in one revision.

`/api/content/**` is read-only and serves only `published`. To write, use server code, the Console, the Agent Capability, or your own route.

Each collection reads the `published` head, and refreshes when another process or host published, so all instances agree without a shared cache.

Saves to different documents never conflict. When another save moves the draft head, Content commits again on the new head. Pass `ifDigest` to reject a save when the same document changed. See [Server API](/docs/content/server-api#conflicts).

### Validation for every writer

Content adds a `vitehub.content` Workspace plugin with a `write:validate` hook for each collection path. What it accepts depends on the target:

| Where | Accepted |
| --- | --- |
| The `draft` ref | Unfinished work: fields may fail validation. It refuses a file that is not an object of fields: invalid YAML or JSON, a root that is not one object, or a body on a JSON or YAML document. |
| `published`, any other ref, and Workspace `fs` writes | Only documents whose fields validate. |

Every writer goes through the hook: Workspace `fs` writes, Sessions, Agents, and history commits. A refused write fails with `CONTENT_INVALID`. The hook also checks other writes at a document path:

- **Deletes.** A draft delete works like `remove()`. A delete on `published` fails with `CONTENT_R0013`. A document leaves the site only when `publish()` publishes its deletion.
- **Directories.** `mkdir` at a document path, such as `posts/hello.md`, fails with `CONTENT_INVALID`. Folders of documents, such as `posts/2026`, are allowed.
- **Bytes.** Binary content must be UTF-8 text and a valid document for its ref, else it fails with `CONTENT_INVALID`.

### Drafts in progress

`save()` stores invalid fields in the draft and returns them as `issues`, so an editor can autosave unfinished work. `data` returns the values as written. `status()` counts the issues. `get({ ref: 'draft' })` and `list({ ref: 'draft' })` return them.

```ts fragment
const draft = await posts.save('hello', { data: { title: '' } })
draft.issues // [{ field: 'title', path: [], message: 'Add a title.' }]
await content.publish({ collection: 'posts' }) // CONTENT_INVALID naming posts/hello
```

`publish()` and `schedule()` validate every document they would publish. One with issues fails the whole call with `CONTENT_INVALID`, and nothing is published. `details.documents` names each invalid document and its issues.

`save()` still throws `CONTENT_INVALID` for input that cannot become a file: `data` that is not a plain object, values that do not survive a JSON round trip, a body that is not a string, or a body on a JSON or YAML document.

The hook starts when `server/content.ts` loads, through the generated Content route or any import of `content`. `publish()` validates again, so a file written before the hook cannot reach `published` unless it is valid.

### Sources and collections together

A runtime can combine read-only `sources` with `collections`. They share one namespace, so a collection cannot reuse a Source name. Use Sources for content you change in code, such as repository files, and collections for content edited at runtime.

## Access

`authorize` decides what a user may do with a collection. The [Console content editor](/docs/content/console) and the [Agent Capability](/docs/content/agent-capability) call it through `content.can()`. The Agent Capability passes the Auth user behind the Actor as `user`, and the Actor as `actor`.

```ts [server/content.ts] fragment
export default defineContent({
  extends: cms,
  collections: { posts },
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

| Field | Value |
| --- | --- |
| `user` | The signed-in Auth user, or `null`. The Console passes the Console user. An Agent passes its Actor's Auth user, or `null`. |
| `actor` | The Agent Invocation's Actor when an Agent calls, such as the Agent Capability. Else `undefined`. |
| `collection` | The collection name. |
| `action` | `read` for drafts, `write` for save, remove, and restore, or `publish`. |
| `id` | The document, if the action targets one. |

One policy covers people and Agents. Check `actor` to give Agents less than their user:

```ts [server/content.ts] fragment
authorize: ({ user, actor, action }) => {
  if (user?.role !== 'editor') return false
  return actor === undefined || action !== 'publish'
},
```

Without `authorize`, `content.can()` returns `false` for every action, and `content.hasPolicy` is `false`. A preset can set a default: with `extends: [cms, { access: 'roles' }]`, the [CMS roles](/docs/cms/access) decide, and your `authorize` replaces them. With no policy, the Console shows no collections and asks you to add `authorize`. Published documents are public through `/api/content/**`. `read` covers drafts, including a [preview cookie](/docs/content/preview). The [Agent Capability](/docs/content/agent-capability#access-and-approval) also checks `read` on each published document it shows.

::warning
Runtime methods, such as `save()` and `publish()`, are trusted server API and skip `authorize`. Check `content.can()` before you call them from a route that acts for a user.
::

### Sources parsed at build

A server build parses each `glob()` and `files()` Source once and ships the parsed documents with the server. A cold server, such as a new Cloudflare Worker isolate, then reads them and does not parse the Markdown again. `list()` and `navigation()` read only the index of the documents, `get()` reads the part of the snapshot that holds its document, and the first search reads all of it. `vite dev` parses the files live, so edits show at once. Collections are not parsed at build, because their documents change at run time.

- The build loads `server/content.ts` in Node. When it cannot, for example because the file imports a module that only the host provides, the build warns and the server parses the Sources on its first Content request.
- Parse plugins and `file:parsed` hooks run at build, so their options must give the same result there as on the server. `file:bulk:load` runs on the server when all the parsed documents load, such as on the first search, with full bodies. It does not run at build, so index plugins such as `sql-query` do not write to your Database during the build.
- `list()` entries carry the metadata of a full parse, such as `readingTime`, and their `meta.partial` is `false`.
- `refresh()` parses the Source again.
- A `glob()` whose options are not literals reads its files from disk at run time, so the server parses it.
- A `github()` Source is parsed at build only when the build has a GitHub token. The build ships the latest commit of its branch, and the server serves it while the head of the Source is that commit. A head that moved loads its commit from KV or GitHub.

The build stores the parsed documents gzipped, and the server inflates each part on its first read. The 344 pages of the ViteHub docs add about 1.5 MB to the server bundle, or 1.1 MB with gzip.

## Providers

Content has no hosted provider. Comark Content keeps its query and search index in the database you pass to a plugin. Collections list, filter, sort, and search in memory, so they need no index plugin.

To add full-text search to read-only Sources, install `comark-content` for the plugin import. Pass `sqlite()` from `vite-hub/content/sqlite` as the index database. It works on every host.

```bash
pnpm add comark-content
```

```ts [server/content.ts]
import sqliteFullTextSearch from 'comark-content/plugins/sqlite-full-text-search'
import { defineContent } from 'vite-hub/content'
import { sqlite } from 'vite-hub/content/sqlite'
import { glob } from 'vite-hub/source'

export default defineContent({
	plugins: [sqliteFullTextSearch({ database: sqlite() })],
	sources: {
		docs: glob({ cwd: 'docs', include: '**/*.md' }),
	},
})
```

`sqlite()` keeps the index in memory. Each server instance builds its own index when Content loads, so it needs no Database and no migration. On Node runtimes, such as the Node, Vercel, and Netlify hosts, it uses Node SQLite. On Cloudflare Workers it uses SQLite WASM, because Node SQLite there is a stub.

A Worker can compile WebAssembly only while it starts, and Content loads on its first request. So when `server/content.ts` imports `vite-hub/content/sqlite`, ViteHub loads SQLite WASM when the Worker starts. This adds about 0.6 MB gzip to the Worker and about 15 ms to its startup. If you import it only from another file, the first search fails with `CONTENT_R0018`.

For client search, pass `searchClient()` from `comark-content/plugins/sqlite-full-text-search/client` to `createContentClient({ plugins: [searchClient()] })`. Review [Limits and errors](/docs/content/limits-and-errors) before running multiple server instances. Comark's own `comark-content/database/sqlite-node` and `comark-content/database/sqlite-wasm` adapters also work on Node runtimes, but not on Cloudflare Workers.

The `vitehub()` Vite plugin and the Nuxt module generate the Content route for every host. Libraries that use owner packages get it from `hubSource()` in `@vite-hub/source/vite`. Each Source loader must also work on the host. `glob()` with literal options works everywhere, because the build bundles its files. See [Hosts without a file system](/docs/source/configure#hosts-without-a-file-system).

See [Limits and errors](/docs/content/limits-and-errors) before running Content in production.

## Render Markdown with Comark UI

Content bundles the Comark UI parser preset, with the HTML-only `annotate`, `diff`, and `quiz` plugins off. ViteHub UI has the matching components and styles. Render a Content page directly:

```vue
<script setup lang="ts">
import { Markdown } from "vite-hub/ui/markdown"

const { data: page } = await useFetch("/api/content/get/docs/introduction")
</script>

<template>
  <Markdown v-if="page" :value="page" />
</template>
```

With the owner packages, use `@vite-hub/ui/markdown`. You need no Comark UI install, component map, or stylesheet. `components` overrides single renderers. It also takes a Markdown string and streams.

`markdown.plugins` extends the preset. A plugin with a preset plugin's name replaces it, so an app can set file readers, icon collections, or a private diagram service. The include plugin stays off. Badges and chips load images by URL.

Content's collaborative editor and the Console use `createContentEditorCodec()` from `vite-hub/content/editor` for schema, Markdown conversion, and the loss check. Content installs its Comark and Tiptap runtimes, so apps do not configure them. Components need no separate editor node definition. A document that cannot round-trip opens read-only and stays editable in Source.

### Render HTML on the server

A server route without Vue renders a document with `renderContentHtml()` from `vite-hub/content`. It uses Content's Comark UI preset, so math and other preset components render as HTML. You do not install `@comark/html` or `comark-ui`.

```ts [server/routes/guides/[slug].get.ts]
import { defineHandler, getRouterParam } from 'h3'
import { renderContentHtml } from 'vite-hub/content'
import content from '../../content'

export default defineHandler(async (event) => {
  const guide = await content.get(`/guides/${getRouterParam(event, 'slug')}`)
  if (!guide) return new Response('Not found', { status: 404 })
  return new Response(`<article>${await renderContentHtml(guide)}</article>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
})
```

Pass `components` to render the app's own blocks, such as `::alert`. A component gets the node and a `render()` for its children:

```ts fragment
await renderContentHtml(guide, {
  components: {
    alert: async ([, attributes, ...children], { render }) => `<aside class="alert">${await render(children)}</aside>`,
  },
})
```

An unknown component renders as an element with its tag name. Pass a document from `content.get()`, because list results have no `nodes`.

### Migrate an existing Comark setup

Replace the app's Comark renderer, component map, and stylesheet imports with `Markdown` from `vite-hub/ui/markdown`. Pass the parsed page as `value`. Keep only app-specific overrides in `components`.

Remove Comark UI and Tiptap packages you installed only for Content. Keep packages the app imports directly, such as search plugins or custom editor extensions.

For a custom editor, use `createContentEditorCodec()` or `contentRealtimeEditor()` from `vite-hub/content/editor`. The `contentEditorComponents`, `contentEditorKitOptions`, `contentMarkdownLossOf`, and `describeContentMarkdownLoss` helpers are removed. Use the codec's `verify()` method. There are no compatibility aliases.
