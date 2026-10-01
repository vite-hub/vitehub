---
title: Content
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 8.5
navigation.group: Files and execution
icon: i-lucide-file-text
---

Use Content when Markdown, JSON, YAML, or media from one or more Sources should become a parsed runtime API with documents, navigation, queries, and full-text search.

ViteHub owns Source retrieval, the generated `/api/content/**` route, and the Source adapter. [Comark Content](https://content.comark.dev) owns document parsing, manifests, navigation, cache entries, SQL queries, full-text search, and the client contract. Content works without Agents.

::tip
Choose the primitive by what the caller needs:

- [Source](/docs/server-primitives/source): read-only retrieval of raw files and records.
- Content: parsed documents with navigation, queries, and full-text search over Source content.
- [Workspace](/docs/server-primitives/workspace): a mutable file tree. Its filesystem search covers every visible file, including generated and non-content files.
- [Collections](/docs/server-primitives/source#expose-a-typed-collection): typed, paginated application read models over records.
::

## Quick start

::steps{level="3"}

### Install

`comark-content` is an optional peer dependency of `vite-hub`. Install it with the framework package.

```bash [Terminal]
pnpm add vite-hub comark-content
```

### Configure

Content needs no extra configuration key. The `vitehub()` Vite plugin and the Nuxt module discover `server/content.ts` and serve its exported `content` instance at `/api/content/**`. Do not add a framework route or a `fetch()` wrapper.

### Start using it

```ts [server/content.ts]
import sqlite from 'comark-content/database/sqlite-node'
import sqliteFullTextSearch from 'comark-content/plugins/sqlite-full-text-search'
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source/glob'

export const content = defineContent({
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

Read it from server code:

```ts [server/api/guide.get.ts]
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/guide')
})
```

Or read the generated route from the client:

```ts [app/utils/content.ts]
import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient({
  plugins: [searchClient()],
})

await content.search('runtime', { instances: ['docs'] })
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineContent` from `vite-hub/content` | Define the Content runtime that ViteHub serves from `server/content.ts`. |
| `contentSource` from `vite-hub/content` | Adapt one Source and set Comark options such as `prefix` and `schema`. |
| `defineContentHandler` from `vite-hub/content` | Adapt a Content runtime to an H3 or Nitro route in another server. |
| `createContentClient`, `defineContentClientPlugin` from `vite-hub/content/client` | Use or extend the typed Comark Content client. |
| `comark-content/database/*`, `comark-content/plugins/*`, `comark-content/sources/*` | Comark databases, parser and search plugins, and native Comark Sources. |

Libraries can install `@vite-hub/content` and use the matching `@vite-hub/content` and `@vite-hub/content/client` imports.

## Definition options

`defineContent(options)` accepts one Source or a map of named Sources. A single `source` becomes an instance named `default`. Named `sources` become one Comark instance each, composed with Comark's `contentHub()`.

| Option | Type | Description |
| --- | --- | --- |
| `source` | Content Source input | One Source. Cannot be combined with `sources`. |
| `sources` | `Record<string, ContentSourceInput>` | Named Sources. Each name becomes a Content instance. |
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

## Providers

Content has no hosted provider. Comark Content stores its query and search index in the database that you pass to a plugin.

| Database | Import | Use |
| --- | --- | --- |
| Node SQLite | `comark-content/database/sqlite-node` | Node runtimes with built-in SQLite. |
| SQLite WASM | `comark-content/database/sqlite-wasm` | Runtimes where Node SQLite is unavailable. |

The `vitehub()` Vite plugin generates the Content route for every preset. The Nuxt module installs the same behavior. Libraries that use owner packages get it from `hubSource()` in `@vite-hub/source/vite`. Each Source loader must also work on the host. For example, `glob()` reads the local file system at runtime.

## Runtime API

`defineContent()` returns a Comark Content hub with ViteHub adapters for named Sources.

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

Methods that plugins add, such as SQL queries, stay available on the returned runtime.

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

## Limits

- Define either `source` or `sources`. Passing both throws.
- A project has one Content file. More than one `content.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) across server directories fails route generation with `SOURCE_B0007`. The file must export `content`, or generation fails with `SOURCE_B0008`.
- Public paths must stay inside the Source root. ViteHub rejects absolute paths, `.` and `..` segments, Windows drive paths, and paths that start with `.git` or `.vitehub` (`CONTENT_R0001`).
- Two items with the same public path fail the load (`CONTENT_R0003`).
- An item without `content` or `data` fails to parse (`CONTENT_R0002`).
- Raw media uses the newest Source revision that finished enumeration.
- `defineContent()` uses `AsyncLocalStorage` from `node:async_hooks`. The runtime must provide it.

## Connect Content to Agents

Content has no Agent Capability. To give an Agent the same files, bind the Source to a [Workspace](/docs/server-primitives/workspace) and attach the [Workspace Shell Capability](/docs/capabilities/workspace-shell).

## Next steps

- Configure retrieval through [Source](/docs/server-primitives/source).
- Persist and edit files through [Workspace](/docs/server-primitives/workspace).
- Read the [Comark Content documentation](https://content.comark.dev/getting-started/introduction).
