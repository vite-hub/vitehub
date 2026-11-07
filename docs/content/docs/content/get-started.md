---

title: Read your first Content document
description: Turn a Markdown file into a document and read it from an API route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Content turns your Markdown files into documents that your app can read. A document has the headings and the body of the file, ready to show on a page.

In this tutorial, you write `docs/intro.md`. Then you read it as a document from an API route.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer, pnpm, and a Vite app. Run the commands in the root folder of the app. You need no account and no API key.

::tutorial-step{title="Install and configure"}
## Install and configure

Add ViteHub, Content, and the server packages to your app:

```bash pm [commands/install]
pnpm add vite-hub @vite-hub/content nitro h3
pnpm add -D vite
```

Add `vitehub()` and `nitro()` to `vite.config.ts`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro()],
})
```

- `vitehub()` finds the `server/content.ts` file that you write in the next step.
- `nitro()` gives your app a server for its API routes.

::

::tutorial-step{title="Define and read Content"}
## Define and read Content

Create `server/content.ts`. It tells Content where your Markdown files are:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source/glob'

export const content = defineContent({
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

`docs` is a Source. A Source is a place that Content reads documents from. This one reads every `.md` file in the `docs` folder of your project.

Create the Markdown file:

```md [docs/intro.md]
# Hello from Content

This page came from a local Source.
```

Create an API route that reads it:

```ts [server/api/guide.get.ts]
import { defineEventHandler } from 'h3'
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/intro')
})
```

`content.get('/intro')` finds `docs/intro.md` and returns it as a document. With this route, you can test Content before you build a page.

You can also read the same document in browser code. This file is optional:

```ts [app/utils/content.ts]
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient()

await content.get('/intro')
```

`createContentClient()` calls the routes that Content adds to your server. It has the same `get()` method.

::

::tutorial-step{title="Read one document"}
## Read one document

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal, and call your route:

```bash [commands/request]
curl http://localhost:5173/api/guide
```

The response is the `Hello from Content` document, as JSON.

To show the document on a page, use [ViteHub UI Markdown](/docs/ui/markdown#content-pages). To search your documents, add [full-text search](/docs/content/configure#providers).

You can change the `docs` Source only when you edit the files in your repository. Do you want people or Agents to edit documents while the app runs, with drafts and publishing? Add a [document collection](/docs/content/configure#document-collections).

::

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code" to="/docs/content/server-api"}
See every Content method, such as list, save, and publish.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/content/configure"}
Add Sources, document collections, search, and access rules.
:::
::
