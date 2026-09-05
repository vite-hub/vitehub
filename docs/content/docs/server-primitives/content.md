---
title: Content
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 8.5
navigation.group: Files and execution
icon: i-lucide-file-text
---

Use Content when Markdown, JSON, YAML, or media from one or more Sources should become a parsed runtime API.

ViteHub owns Source retrieval and framework integration. [Comark Content](https://content.comark.dev) owns document parsing, manifests, navigation, cache entries, SQL queries, full-text search, and the client contract.

## Install

```bash [Terminal]
pnpm add vite-hub comark-content
```

## Define Content

```ts [server/content.ts]
import sqlite from 'comark-content/database/sqlite-node'
import sqliteFullTextSearch from 'comark-content/plugins/sqlite-full-text-search'
import { defineContent } from 'vite-hub/content'

export const content = defineContent({
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: 'docs',
  },
})

await content.get('/guide')
await content.navigation(['docs'])
await content.search(['docs'], 'runtime')
```

ViteHub discovers `server/content.ts` and serves its exported `content` instance at `/api/content/**` in Vite and Nuxt. No manual framework route or `fetch()` wrapper is required.

Registered ViteHub Source names, explicit Source Readers, and native Comark Content Sources can coexist. `defineContent()` gives each adapted Source load a separate adapter that keeps its selected Reader until all parser reads finish. Registered Source names and Reader factories select a new Reader for each load. Explicit Readers stay fixed. Overlapping refreshes, fresh snapshots, and fresh document reads therefore keep their selected revisions. Raw media uses the newest successfully enumerated Source revision. Native Comark Content Sources pass through unchanged.

A direct `contentSource()` adapter selects a Reader when `keys()` starts an enumeration. Its later `getItem()` calls use that Reader until the next enumeration. Use `defineContent()` to isolate overlapping loads.

Use `sqlite-wasm` where Node SQLite is unavailable. Comark Content owns parsed document cache entries and exposes `refresh(source)`, `invalidate(key)`, and `expire(key)`.

## Use the client

```ts [app/utils/content.ts]
import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient({
  plugins: [searchClient()],
})

await content.search(['docs'], 'runtime')
```

## Public imports

| Import | Use |
| --- | --- |
| `defineContent`, `contentSource`, `defineContentHandler` from `vite-hub/content` | Define the runtime, adapt ViteHub Sources, or mount the handler in another server. |
| `createContentClient` from `vite-hub/content/client` | Use the typed Comark Content client. |

Libraries can install `@vite-hub/content` and use the matching owner-package imports.

Workspace keeps its filesystem search because it searches every visible file, including generated and non-content files. Collections remain typed, paginated application read models over records.

## Next steps

- Configure retrieval through [Source](/docs/server-primitives/source).
- Read the [Comark Content documentation](https://content.comark.dev/getting-started/introduction).
