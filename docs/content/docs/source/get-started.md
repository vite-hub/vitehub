---

title: Read your first Source
description: Define a local glob Source, read one known Markdown file through it, and check the result from a server route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Source tells your server where to find data that it only reads, such as a folder of Markdown files. You write the Source once. Your server code then reads each file by its name.

In this tutorial, you make a Source for a `docs` folder and read the file `docs/intro.md` from an API route. The route returns the file as it is. It does not turn the Markdown into HTML.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run every command from the app root. You need no account. All files stay on your computer. If your app must also write files, use [Workspace](/docs/workspace) instead.

::tutorial-step{title="Configure"}
## Configure

Source comes with `vite-hub`, so you install nothing. Check that `nuxt.config.ts` or `vite.config.ts` adds ViteHub. Keep the other plugins of your app. You do not need a `source` option, because your route imports the Source file itself.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node' },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' })],
})
```
::::
:::

::

::tutorial-step{title="Define a Source"}
## Define a Source

Create `server/sources/docs.ts`. A glob Source reads the files in a folder that match a pattern.

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

- `cwd: 'docs'` reads from the `docs` folder. The name of each file is relative to that folder, so `docs/intro.md` is `intro.md`.
- `include: '**/*.md'` takes every Markdown file in the folder and its subfolders.

Create `docs/intro.md`, so the route has a file to read:

```md [docs/intro.md]
# Hello from Source

This file is loaded by the glob Source.
```

Create `server/api/docs.get.ts`. This route reads `intro.md` through the Source.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

- `createSource(docs)` opens a reader for the Source.
- `reader.read('intro.md')` reads one file by its name.

Use the reader only in server code. It reads files on the server, not in the browser. [Hosts without a file system](/docs/source/configure#hosts-without-a-file-system) explains what happens to the files when you build and deploy.

::

::tutorial-step{title="Read one file"}
## Read one file

Start the dev server:

```bash [commands/start]
pnpm dev
```

Open a second terminal, and call the route:

```bash [commands/request]
curl http://localhost:3000/api/docs
```

The response has the `intro.md` file that you created, with the text `Hello from Source`.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/source/configure"}
Load data from GitHub, collections, or your own data store.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/source/server-api"}
Read items, combine Sources, and expose a typed Collection.
:::
::
