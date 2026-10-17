---
title: Content
navigation.title: Overview
description: Parse, query, search, and serve Source content with Comark Content, and edit document collections with drafts and publishing.
navigation.order: 1
icon: i-lucide-file-text
---

::product-hero{tagline="Parsed Markdown, JSON, YAML, and media from Sources, plus editable document collections with drafts and publishing, served from one generated route on every preset." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [Definition]
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

  ```ts [Collections]
  import { defineContent, documents } from 'vite-hub/content'
  import { z } from 'zod'

  export const content = defineContent({
    workspace: 'site',
    collections: {
      posts: documents({
        path: 'posts/**/*.md',
        fields: { title: z.string(), date: z.coerce.date() },
      }),
    },
  })

  const posts = content.collection('posts')
  await posts.save('hello', { data: { title: 'Hello', date: '2026-10-14' }, body: '# Hello' })
  await content.publish({ collection: 'posts', ids: ['hello'] })
  ```

  ```ts [Route]
  import { content } from '../content'

  export default defineEventHandler(async () => {
    return {
      page: await content.get('/guide'),
      navigation: await content.navigation(['docs']),
      results: await content.search(['docs'], 'runtime'),
    }
  })
  ```

  ```ts [Client]
  import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
  import { createContentClient } from 'vite-hub/content/client'

  export const content = createContentClient({
    plugins: [searchClient()],
  })

  await content.search('runtime', { instances: ['docs'] })
  ```
  :::
::


::product-features
  :::product-feature-item{title="One Source definition feeds Content and direct reads" icon="i-lucide-folder-input" to="/docs/content/configure"}
  Each named Source in `defineContent()` becomes one Comark instance.
  :::

  :::product-feature-item{title="Edit documents with drafts and publishing" icon="i-lucide-file-pen" to="/docs/content/configure#document-collections"}
  Collections validate frontmatter fields, save drafts to Workspace history, and serve only what you publish.
  :::

  :::product-feature-item{title="Preview drafts through your real pages" icon="i-lucide-eye" to="/docs/content/preview"}
  A signed cookie makes one browser read drafts while the public site serves published content.
  :::

  :::product-feature-item{title="Documents, navigation, and search from server code" icon="i-lucide-code-2" to="/docs/content/server-api"}
  `content.get()`, `content.navigation()`, and `content.search()` run in server code.
  :::

  :::product-feature-item{title="The search index lives in SQLite" icon="i-lucide-search" to="/docs/content/configure#providers"}
  The `sqlite-full-text-search` plugin uses Node SQLite or SQLite WASM.
  :::

  :::product-feature-item{title="The client reads the generated route directly" icon="i-lucide-radio" to="/docs/content/server-api#client"}
  `createContentClient()` calls `/api/content/**`, served by the Vite plugin or Nuxt module.
  :::

  :::product-feature-item{title="Give an Agent the files through Workspace" icon="i-lucide-bot" to="/docs/workspace/agent-capability"}
  Bind the same Source to a Workspace and attach `workspaceShell()`.
  :::

  :::product-feature-item{title="Templates stay typed" icon="i-lucide-file-code-2" to="/docs/content/server-api"}
  Render Markdown and data with one server-side content import.
  :::
::
