---

title: Build your first Workspace
description: Read a mounted Markdown file and write a draft with explicit Workspace access.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Workspace is a folder of files that your server code can read and change. It tracks your changes as a diff, a list of what changed. A Source is read-only content that you put inside a Workspace, such as a folder of Markdown files.

In this tutorial, you list Markdown files from a local folder. Then you write a draft into the Workspace and see the change. The original files do not change.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key. The files are saved on your computer. Before you deploy, read [Hosts](/docs/workspace/hosts) to choose storage.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the Workspace package:

```bash pm [commands/install]
pnpm add @vite-hub/workspace valibot
```

Add `workspace: true` to the ViteHub options of your app. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', workspace: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workspace: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workspace: true })],
})
```
::::
:::


::

::tutorial-step{title="Define the Workspace"}
## Define the Workspace

Create `server/workspaces/docs.ts`. The file name is the name of the Workspace: `docs`.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from 'vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

- `sources.docs` adds a Source named `docs` to the Workspace.
- `glob({ cwd: 'docs', include: '**/*.md' })` reads every Markdown file in the `docs` folder of your app. In the Workspace, those files are under `docs/`.

Create the `docs` folder and a sample file in it, so the read route has a file to find:

```md [docs/intro.md]
# Workspace sample

This document comes from a read-only Source.
```

::

::tutorial-step{title="Add read and write routes"}
## Add read and write routes

Create a route that lists the Markdown files in the Workspace:

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { useWorkspace } from 'vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

- `useWorkspace('docs')` opens the Workspace. By default, it can only read.
- `workspace.fs.glob('**/*.md')` lists the Markdown files. The list includes the files from the Source.

Create a second route that writes a draft:

```ts [server/api/drafts.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { useWorkspace } from 'vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readValidatedBody(event, body => v.parse(v.object({ text: v.string() }), body))

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

- `readValidatedBody()` answers `400` when the body has no `text` string.
- `{ mode: 'write' }` asks for write access. In read mode, `workspace.fs` has no `writeFile()`.
- `writeFile()` saves the draft in the Workspace. It does not change the files in your `docs` folder.
- `diff()` returns the changes that wait to be saved, here the new draft.

::

::tutorial-step{title="Read and write the tree"}
## Read and write the tree

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal and call the read route:

```bash [commands/request]
curl http://localhost:3000/api/docs
```

The response lists the Markdown files. It includes `docs/intro.md`. Now send a draft to the write route:

```bash [commands/write]
curl -X POST http://localhost:3000/api/drafts \
  -H 'content-type: application/json' \
  -d '{"text":"# Draft"}'
```

The response is the diff. It shows the new file `drafts/summary.md`. Your `from` and `to` values are different:

```json [output/diff.json]
{
  "from": "361e4d3ccd99a3c02491bb7bea076549e9886868e5cd701c3a3ec10938534a09",
  "to": "b39f89281fd2971be9b8949b030c6382186e6df7347c52c1648c22ca9f060b96",
  "entries": [
    { "path": "drafts", "type": "added", "after": { "type": "directory" } },
    {
      "path": "drafts/summary.md",
      "type": "added",
      "after": {
        "type": "file",
        "digest": "2f8aa1f6d9602d7214a36d962d142cffa28dd28a8adf24bcf5c4589db06d52ff",
        "size": 7
      }
    }
  ]
}
```

Request `/api/docs` again, and the list also has the draft. The file `docs/intro.md` in your app does not change.

::

## Next steps

::card-group
:::card{title="Workspaces and Sources" icon="i-lucide-folder-git-2" to="/docs/workspace/concepts"}
Learn when to use a Workspace, a Source, or both.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/workspace/server-api"}
Take snapshots, make commits, and sync Sources.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/workspace/hosts"}
Choose where a deployed app keeps its files.
:::
::
