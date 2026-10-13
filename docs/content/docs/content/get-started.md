---

title: Read your first Content document
description: Parse a local Markdown file and read its Content document from a route.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Turn `docs/intro.md` into a parsed Content document and read it through an API route. A Source finds the Markdown file; Content parses it so the app can use its headings and body. The example also enables full-text search.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The search plugin uses local SQLite state. Review [Content configuration](/docs/content/configure) before running the app across multiple instances.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Comark Content with ViteHub. It is an optional peer, so ViteHub does not install it for every app.

```bash [commands/install]
pnpm add vite-hub comark-content nitro h3
pnpm add -D vite
```

Add ViteHub and Nitro to your existing Vite config. ViteHub discovers the `server/content.ts` file in the next step. Nitro serves the app's API routes.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro() as never],
})
```

::

::tutorial-step{title="Define and read Content"}
## Define and read Content

The `docs` Source reads Markdown under the project's `docs` directory. The search plugin indexes the parsed documents in SQLite.

```ts [server/content.ts]
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

Add the document that the route will read:

```md [docs/intro.md]
# Hello from Content

This page came from a local Source.
```

`content.get('/intro')` resolves `docs/intro.md`. This route lets you check the server API without building a page first.

```ts [server/api/guide.get.ts]
import { defineEventHandler } from 'h3'
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/intro')
})
```

This client module is optional for the first request. It shows how a browser can use the generated Content routes. Search for `Hello` to match the file you just created.

```ts [app/utils/content.ts]
import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient({
  plugins: [searchClient()],
})

await content.search('Hello', { instances: ['docs'] })
```

::

::tutorial-step{title="Read one document"}
## Read one document

Start Vite, then read the `guide` route you just created:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/guide
```

The response contains the parsed `Hello from Content` document. Read
[Server API](/docs/content/server-api) for every Content method.

::
