---
title: Source
navigation.title: Overview
description: Read files and data from your project, a GitHub repository, or your own code without changing them, and serve lists as paged API routes.
navigation.order: 1
icon: i-lucide-folder-input
---

::product-hero{tagline="Read files from your project, GitHub, or your own data with one reader, and turn lists into paged API routes." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [server/sources/docs.ts]
  import { github } from 'vite-hub/source/github'
  import { glob } from 'vite-hub/source/glob'

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
  :::
::

::product-features
  :::product-feature-item{title="Ready-made readers" icon="i-lucide-files" to="/docs/source/configure#source-loader-options"}
  Read one file, a folder of files, or a GitHub repository. Your files do not change.
  :::

  :::product-feature-item{title="Read from any route" icon="i-lucide-code-2" to="/docs/source/server-api#source-reader-api"}
  `createSource()` opens a reader. `keys()`, `read()`, and `list()` get the files you need.
  :::

  :::product-feature-item{title="Bring your own data" icon="i-lucide-blocks" to="/docs/source/configure#source-object-contract"}
  `defineSource()` reads from anywhere. Give it a list of keys and a way to load one item. TypeScript infers the types.
  :::

  :::product-feature-item{title="Turn a list into an API route" icon="i-lucide-list" to="/docs/source/server-api#expose-a-typed-collection"}
  Add a file to `server/collections` to get a GET route. In Vue, `useCollection()` loads it one page at a time.
  :::

  :::product-feature-item{title="Filter and search a list" icon="i-lucide-list-filter" to="/docs/source/server-api#collections-over-an-array"}
  `array()` adds filters, search, and counts to a list that fits in server memory.
  :::

  :::product-feature-item{title="Keep a list private" icon="i-lucide-shield-check" to="/docs/source/server-api#protect-a-collection"}
  Set `authorize` to allow only signed-in users. Other requests get a `401` or `403` error.
  :::
::
