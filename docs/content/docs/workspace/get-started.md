---

title: Build your first Workspace
description: Read a mounted Markdown file and write a draft with explicit Workspace access.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

List Markdown files from a local Source, then add a draft to the Workspace's writable file tree. A Workspace combines files with access rules and tracks changes as a diff. The read route and write route will ask for different access modes.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. This example uses the default local store. Read [Hosts](/docs/workspace/hosts) before choosing storage for a deployed app.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Workspace and Nitro. Add the plugins below to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add @vite-hub/workspace nitro h3
pnpm add -D vite
```

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkspace(), nitro() as never],
})
```

::

::tutorial-step{title="Define the Workspace"}
## Define the Workspace

The Definition name comes from `server/workspaces/docs.ts`. The Source reads Markdown under the local `docs` directory and mounts it as `docs` in the Workspace. Create the sample file below before requesting the read route.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

Create the directory and this file in your app. It gives the read route a known Markdown document to find:

```md [docs/intro.md]
# Workspace sample

This document comes from a read-only Source.
```

::

::tutorial-step{title="Add read and write routes"}
## Add read and write routes

The default mode permits reads. `glob()` lists the Markdown paths visible through the Workspace, including files mounted from the Source.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

This route asks for write mode because it creates a draft. Writing changes the Workspace store; it does not write back to the mounted Source. `diff()` reports the pending change.

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

::

::tutorial-step{title="Read and write the tree"}
## Read and write the tree

Start Vite and call the read route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/docs
```

The response lists Markdown files from the `docs` mount, including the `docs/intro.md` sample. Send a draft to the write route:

```bash [commands/write]
curl -X POST http://localhost:5173/api/drafts \
  -H 'content-type: application/json' \
  -d '{"text":"# Draft"}'
```

The write response reports the new `drafts/summary.md` in a Workspace diff. Request `/api/docs` again to see it in the file listing. The Source file still contains its original content. Read [Server API](/docs/workspace/server-api) for snapshots, commits, and Source sync.

::
