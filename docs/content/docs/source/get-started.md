---

title: Read your first Source
description: Define a local glob Source, read one known Markdown file through it, and check the result from a server route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Source points your server at read-only data, such as a folder of Markdown files. You define the Source once. Your server code then reads each file by its name.

In this tutorial, you define a Source for a `docs` folder and read `docs/intro.md` from an API route. The route returns the raw Markdown without converting it to HTML.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. Everything stays on your computer, with no account needed. If your app also needs to write files, use [Workspace](/docs/workspace) instead.

::tutorial-step{title="Configure"}
## Configure

Source ships with `vite-hub`, so you install nothing extra. Check that `nuxt.config.ts` or `vite.config.ts` adds ViteHub alongside your other plugins. You need no `source` option: ViteHub discovers Sources in `server/sources/`.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {},
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub(), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub()],
})
```
::::
:::

::

::tutorial-step{title="Define a Source"}
## Define a Source

Create `server/sources/docs.ts`. A `glob()` Source reads every file in a folder that matches a pattern. ViteHub names the Source after the file, so this Source is `docs`.

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source'

export default glob({ cwd: 'docs', include: '**/*.md' })
```

- Each file in `server/sources/` must default-export a Source.
- `cwd: 'docs'` reads from the `docs` folder. Each file name is relative to that folder, so `docs/intro.md` is `intro.md`.
- `include: '**/*.md'` matches every Markdown file in `docs` and its subfolders.

Create `docs/intro.md` so the route has a file to read:

```md [docs/intro.md]
# Hello from Source

This file is loaded by the glob Source.
```

Create `server/api/docs.get.ts` to read `intro.md` through the Source.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { useSource } from 'vite-hub/source'

export default defineEventHandler(async () => {
  const reader = useSource('docs')
  return reader.read('intro.md')
})
```

- `useSource('docs')` opens a reader for `server/sources/docs.ts`. ViteHub generates the types, so your editor knows the Source name `docs` and its file names.
- `reader.read('intro.md')` reads one file by its name.
- In Nuxt with `experimental.nitroAutoImports` on, `useSource` is auto-imported in server code, so you can remove its import.

Use the reader only in server code, never in the browser. [Hosts without a file system](/docs/source/configure#hosts-without-a-file-system) explains what happens to the files when you build and deploy.

::

::tutorial-step{title="Read one file"}
## Read one file

Start the dev server:

```bash [commands/start]
pnpm dev
```

From a second terminal, call the route:

```bash [commands/request]
curl http://localhost:3000/api/docs
```

The response returns your `intro.md` file with the `# Hello from Source` heading.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/source/configure"}
Load data from GitHub, collections, or your own data store.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/source/server-api"}
Read items, combine Sources, and serve a typed Collection.
:::
::
