---
title: Workspace
navigation.title: Overview
description: Give your server a folder of files to read and write, with rules for each path and a record of every change.
navigation.order: 1
icon: i-lucide-folder-git-2
---

::product-hero{tagline="A folder of files your server can read and write, with rules for each path and a record of every change." hosts="Node, Docker, Cloudflare, Vercel"}
  :::product-files
  ```ts [server/workspaces/docs.ts]
  import { defineWorkspace, glob } from 'vite-hub/workspace'

  // This file defines the docs Workspace.
  export default defineWorkspace({
    sources: {
      // Markdown from your docs folder
      docs: glob({ cwd: 'docs', include: '**/*.md' }),
    },
    rules: {
      // Your files stay read-only
      'docs/**': { write: false },
    },
  })
  ```

  ```ts [server/workspaces/handbook.ts]
  import { defineWorkspace, github } from 'vite-hub/workspace'

  // Files from a GitHub repository.
  // Private repositories read GITHUB_TOKEN.
  export default defineWorkspace({
    sources: {
      handbook: github({
        repo: 'acme/handbook',
        ref: 'main',
      }),
    },
  })
  ```

  ```ts [server/api/docs.get.ts]
  import { defineEventHandler } from 'h3'
  import { useWorkspace } from 'vite-hub/workspace'

  // List every Markdown file
  export default defineEventHandler(async () => {
    const docs = useWorkspace('docs')
    return docs.fs.glob('**/*.md')
  })
  ```

  ```ts [server/api/drafts.post.ts]
  import { defineEventHandler } from 'h3'
  import { useWorkspace } from 'vite-hub/workspace'

  // Write a draft, return the change
  export default defineEventHandler(async () => {
    const docs = useWorkspace('docs', { mode: 'write' })

    await docs.fs.writeFile('drafts/hello.md', '# Hello')
    return docs.diff()
  })
  ```

  ```md [docs/intro.md]
  # Welcome

  This file is in your project.
  The Workspace shows it under docs/intro.md.
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file defines it" icon="i-lucide-file-code-2" to="/docs/workspace/configure#workspace-definition-options"}
  Add a file to `server/workspaces`. Its name is the Workspace name.
  :::

  :::product-feature-item{title="Start from files you have" icon="i-lucide-folder-input" to="/docs/workspace/configure#source-binding-options"}
  Show files from your project or a GitHub repository. The originals do not change.
  :::

  :::product-feature-item{title="Read and write from a route" icon="i-lucide-code-2" to="/docs/workspace/server-api#runtime-facade"}
  `useWorkspace()` gives each route `readFile()`, `writeFile()`, and `glob()`.
  :::

  :::product-feature-item{title="Decide who can write where" icon="i-lucide-lock" to="/docs/workspace/configure#workspace-definition-options"}
  Rules make a path read-only or limit the file types it accepts.
  :::

  :::product-feature-item{title="See every change" icon="i-lucide-history" to="/docs/workspace/server-api#retained-folder-history"}
  `diff()` lists what changed. A snapshot saves a version you can read later.
  :::

  :::product-feature-item{title="Same code in development and production" icon="i-lucide-server" to="/docs/workspace/hosts"}
  Files stay on your disk while you develop. Your routes do not change when you deploy.
  :::
::
