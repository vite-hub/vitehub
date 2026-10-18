---
title: Content
navigation.title: Overview
description: Turn Markdown files into pages your app can read, list, and search, and let people edit drafts and publish them.
navigation.order: 1
icon: i-lucide-file-text
---

::product-hero{tagline="Turn Markdown files into pages you can read, list, and search, and let people edit and publish them." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [server/content.ts]
  import sqlite from 'comark-content/database/sqlite-node'
  import sqliteFullTextSearch
    from 'comark-content/plugins/sqlite-full-text-search'
  import { defineContent } from 'vite-hub/content'
  import { glob } from 'vite-hub/source/glob'

  export const content = defineContent({
    // Keep a search index in SQLite
    plugins: [
      sqliteFullTextSearch({ database: sqlite() }),
    ],
    // Every Markdown file in your docs folder
    sources: {
      docs: glob({ cwd: 'docs', include: '**/*.md' }),
    },
  })
  ```

  ```md [docs/intro.md]
  # Hello from Content

  This file is in your project.
  Content reads it as the page /intro.
  ```

  ```ts [server/api/intro.get.ts]
  import { defineEventHandler } from 'h3'
  import { content } from '../content'

  // One page, and a menu of every page
  export default defineEventHandler(async () => {
    return {
      page: await content.get('/intro'),
      menu: await content.navigation(['docs']),
    }
  })
  ```

  ```ts [server/api/search.get.ts]
  import { defineEventHandler, getQuery } from 'h3'
  import { content } from '../content'

  // Search every page: /api/search?q=hello
  export default defineEventHandler(async (event) => {
    const { q } = getQuery(event)
    return content.search(['docs'], String(q ?? ''))
  })
  ```

  ```ts [app/utils/content.ts]
  import {
    createContentClient,
  } from 'vite-hub/content/client'

  // Read pages from the browser.
  // It calls the /api/content route for you.
  export const content = createContentClient()

  // await content.get('/intro')
  // await content.navigation()
  ```
  :::
::

::product-features
  :::product-feature-item{title="Write pages in Markdown" icon="i-lucide-file-text" to="/docs/content/get-started#define-and-read-content"}
  Point Content at a folder of Markdown files. It reads the headings and body of each page.
  :::

  :::product-feature-item{title="Read pages from a route" icon="i-lucide-code-2" to="/docs/content/server-api#runtime-api"}
  `content.get()` returns one page. `content.navigation()` builds a menu from all pages.
  :::

  :::product-feature-item{title="Search every page" icon="i-lucide-search" to="/docs/content/configure#providers"}
  Add the full-text search plugin. It keeps its search index in SQLite.
  :::

  :::product-feature-item{title="Read pages from the browser" icon="i-lucide-globe" to="/docs/content/server-api#client"}
  `createContentClient()` reads the `/api/content` route that ViteHub adds for you.
  :::

  :::product-feature-item{title="Edit, then publish" icon="i-lucide-file-pen" to="/docs/content/configure#document-collections"}
  A collection holds pages that people edit in your app. Each save is a draft. Visitors see only what you publish.
  :::

  :::product-feature-item{title="Check every field" icon="i-lucide-list-checks" to="/docs/content/configure#fields"}
  Give each field at the top of a page a rule, such as a title that is not empty. A save with a bad field fails.
  :::
::
