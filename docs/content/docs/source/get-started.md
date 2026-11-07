---
title: Read your first Source
description: Define a local glob Source, read one known Markdown file through it, and check the result from a server route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You write an API route that reads the Markdown file `docs/intro.md` and returns it. You see the file in the response.

A Source tells ViteHub where to find data that your app reads but does not change. Here the data is the Markdown files in the `docs/` folder.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.

You do not need a cloud account. All files stay on your computer.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

`vite-hub` gives you Source. `nitro` and `h3` serve the API route. `vite` runs the dev server.

Add the `vitehub` plugin to `vite.config.ts`. Keep the other plugins that your config already has.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' })],
})
```

`preset: 'node'` builds the app for a plain Node.js server. Source needs no option here, because the route imports the Source file directly.

::

::tutorial-step{title="Create the Source"}
## Create the Source

Create `server/sources/docs.ts`:

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

- `glob()` reads files from a folder on the server.
- `cwd: 'docs'` is that folder. Each file gets a key, which is its path inside `docs/`. The key of `docs/intro.md` is `intro.md`.
- `include: '**/*.md'` keeps only the Markdown files, in all subfolders.

Create `docs/intro.md`, so the route has a file to read:

```md [docs/intro.md]
# Hello from Source

This file is loaded by the glob Source.
```

Create `server/api/docs.get.ts`. `createSource()` opens a reader for the Source. `reader.read()` returns the file with the key that you give it.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

Use the reader only in server code. A glob Source reads the server's file system, so the files must be on the server when the app runs. The route returns the file as text. It does not convert the Markdown.

::

::tutorial-step{title="Read the file"}
## Read the file

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and call the route:

```bash [commands/request]
curl http://localhost:5173/api/docs
```

The response contains the `intro.md` file, with the text `Hello from Source`. This proves that the Source found the file by its key and the route read it.

::

## Next steps

- [Configure](/docs/source/configure): load data from GitHub, collections, or your own data store.
- [Server API](/docs/source/server-api): see all the methods of a reader.
- [Workspace](/docs/workspace): use a folder that your app can also write to.
