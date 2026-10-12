---

title: Read your first Source
description: Read a known Markdown file through a local glob Source.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Read `docs/intro.md` from a server route with a glob Source. A Source describes where to find read-only data, and `createSource()` opens the reader. This example returns the Markdown file without parsing it into a Content document.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. All files stay local and no provider account is needed. Use [Workspace](/docs/workspace) if the application must also write files.

::tutorial-step{title="Install and configure"}
## Install and configure

Install ViteHub and Nitro. Add the plugins below to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Register ViteHub and Nitro in the app. You will import the Source directly in the next step; it does not need a discovery flag.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro() as never],
})
```

::

::tutorial-step{title="Define a Source"}
## Define a Source

`cwd: 'docs'` makes Source keys relative to that directory. The glob includes Markdown files; the key below is `intro.md`, without the `docs/` prefix.

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

Create `docs/intro.md` so the route has a known file to read:

```md [docs/intro.md]
# Hello from Source

This file is loaded by the glob Source.
```

Import the Source directly and open a reader in the route. The reader returns the known file you created, so the result does not depend on directory ordering.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

Keep the reader on the server. A glob Source reads from the server's filesystem, so the app must have these files available when it runs.

::

::tutorial-step{title="Read one file"}
## Read one file

Start Vite and call the route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/docs
```

The response contains the `intro.md` file you created, including `Hello from Source`. Read
[Configure](/docs/source/configure) when the Source should load GitHub,
collections, or a custom data store.

::
