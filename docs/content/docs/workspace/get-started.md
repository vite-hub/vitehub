---
title: Build your first Workspace
description: Read a mounted Markdown file and write a draft with explicit Workspace access.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build two API routes. One route lists the Markdown files in a Workspace. The other route writes a draft file and shows what changed.

A Workspace is a folder of files that your server can read and write. It has access rules, and it tracks each change.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.

You do not need a cloud account. The files stay on your computer.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/workspace nitro h3
pnpm add -D vite
```

`@vite-hub/workspace` gives you Workspace. `nitro` and `h3` serve the API routes. `vite` runs the dev server.

Add the plugins to `vite.config.ts`. Keep the other plugins that your config already has. `hubWorkspace()` finds the Workspaces in `server/workspaces/`.

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkspace(), nitro()],
})
```

::

::tutorial-step{title="Create the Workspace"}
## Create the Workspace

Create `server/workspaces/docs.ts`. ViteHub uses the file name as the Workspace name, so this Workspace is `docs`.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

`sources` adds files from other places to the Workspace. A Source is a place that the Workspace reads files from but does not change. Here, `glob()` reads the Markdown files in your app's `docs/` folder. The key `docs` puts them in the `docs/` folder of the Workspace.

Create `docs/intro.md`, so the read route has a file to find:

```md [docs/intro.md]
# Workspace sample

This document comes from a read-only Source.
```

::

::tutorial-step{title="Add read and write routes"}
## Add read and write routes

Create `server/api/docs.get.ts`. `useWorkspace('docs')` opens the Workspace. By default, it can only read. `fs.glob('**/*.md')` lists all Markdown files in the Workspace, together with the files from the Source.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Create `server/api/drafts.post.ts`. This route asks for `mode: 'write'`, because it creates a file. Each route asks only for the access that it needs.

```ts [server/api/drafts.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readBody<{ text: string }>(event)

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

`writeFile()` saves the draft in the Workspace. It does not change the files in your `docs/` folder. `diff()` returns the changes that are not saved to history yet.

::

::tutorial-step{title="Read and write files"}
## Read and write files

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and call the read route:

```bash [commands/request]
curl http://localhost:5173/api/docs
```

The response lists `docs/intro.md`. This proves that the Workspace reads the files from the Source.

Send a draft to the write route:

```bash [commands/write]
curl -X POST http://localhost:5173/api/drafts \
  -H 'content-type: application/json' \
  -d '{"text":"# Draft"}'
```

The response shows `drafts/summary.md` as a new file. This proves that the write route saved the draft and that the Workspace tracks the change.

Call `/api/docs` again. The list now has `drafts/summary.md` too. Your `docs/intro.md` file does not change.

> [!NOTE]
> This tutorial uses the default store on your computer. Before you deploy, read [Store providers](/docs/workspace/configure#store-providers) and [Hosts](/docs/workspace/hosts) to choose where the files go.

::

## Next steps

- [Server API](/docs/workspace/server-api): save versions, and sync files back to a Source.
- [Configure](/docs/workspace/configure): set access rules and choose a store.
- [Hosts](/docs/workspace/hosts): choose storage for a deployed app.
