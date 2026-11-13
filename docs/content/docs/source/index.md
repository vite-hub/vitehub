---
title: Source
layout: landing
navigation.title: Overview
description: Read files from your project, GitHub, or your own code without changing them, and serve lists as paged routes.
navigation.order: 1
icon: i-lucide-folder-input
---

::product-hero{tagline="Read files from your project, GitHub, or your own data, and turn lists into paged API routes." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="source"}
::

::code-tree
```ts [server/sources/docs.ts]
import { github, glob } from 'vite-hub/source'

// Markdown files from your docs folder
export const docs = glob({
  cwd: 'docs',
  include: '**/*.md',
})

// Files from a GitHub repository
export const handbook = github({
  repo: 'acme/handbook',
  ref: 'main',
})
```

```ts [server/api/intro.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

// Read one file: docs/intro.md
export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

```ts [server/api/handbook.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { handbook } from '../sources/docs'

// List the path of every file in the repository
export default defineEventHandler(async () => {
  const reader = createSource(handbook)
  return reader.keys()
})
```

```ts [server/collections/articles.ts]
import {
  array,
  defineCollection,
} from 'vite-hub/source'

// ViteHub serves this list at /api/articles
export const articles = defineCollection({
  source: array([
    { slug: 'hello', title: 'Hello', tag: 'news' },
    { slug: 'vite', title: 'Why Vite', tag: 'guide' },
  ], {
    filters: ['tag'],
    search: ['title'],
  }),
})
```

```vue [app/pages/articles.vue]
<script setup lang="ts">
import { useCollection } from 'vite-hub/source/client'

// Load the guides, one page at a time
const { items, hasMore, loadMore } =
  useCollection('articles', {
    filter: { tag: 'guide' },
  })
</script>

<template>
  <p v-for="article in items" :key="article.slug">
    {{ article.title }}
  </p>
  <button v-if="hasMore" @click="loadMore()">
    More
  </button>
</template>
```
::

::product-features
  :::product-feature-item{title="Ready-made readers" icon="i-lucide-files" to="/docs/source/configure#source-loader-options"}
  Read a file, a folder, or a GitHub repository. Your files do not change.
  :::

  :::product-feature-item{title="Read from any route" icon="i-lucide-code-2" to="/docs/source/server-api#source-reader-api"}
  `createSource()` opens a reader. `keys()`, `read()`, and `list()` get files.
  :::

  :::product-feature-item{title="Bring your own data" icon="i-lucide-blocks" to="/docs/source/configure#source-object-contract"}
  `defineSource()` reads from anywhere. Give it the keys and a way to load one item. TypeScript infers the types.
  :::

  :::product-feature-item{title="Turn a list into an API route" icon="i-lucide-list" to="/docs/source/server-api#expose-a-typed-collection"}
  A file in `server/collections` becomes a GET route. In Vue, `useCollection()` loads it page by page.
  :::


  :::product-feature-item{title="Filter and search a list" icon="i-lucide-list-filter" to="/docs/source/server-api#collections-over-an-array"}
  `array()` adds filters, search, and counts to a list that fits in memory.
  :::

  :::product-feature-item{title="Keep a list private" icon="i-lucide-shield-check" to="/docs/source/server-api#protect-a-collection"}
  `authorize` allows only signed-in users. Others get `401` or `403`.
  :::
::

::agent-only{skill="source"}
Use Source to read files, records, or external resources through a typed, read-only loader. Sources provide context; they do not grant write authority.

Choose the narrowest loader and scope its root, branch, or query. Validate source provenance and access before passing content to an Agent or route.

Prove a successful read, an out-of-scope path, missing content, and the returned metadata or revision.
::
