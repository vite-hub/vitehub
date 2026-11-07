---

title: Read your first Content document
description: Parse a local Markdown file and read its Content document from a route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You write a Markdown file, `docs/intro.md`, and read it from an API route. At the end, `curl` shows the file as data: its heading and its body, ready for your app to use.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.

You do not need a database or a cloud account.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the packages:

```bash [commands/install]
pnpm add vite-hub @vite-hub/content nitro h3
pnpm add -D vite
```

- `vite-hub` and `@vite-hub/content` read and parse your Markdown files. Content includes Comark, the Markdown parser.
- `nitro` and `h3` serve the API route.

Add ViteHub and Nitro to your Vite config. Keep the other plugins of your app.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro()],
})
```

`preset: 'node'` tells ViteHub that the app runs on a Node.js server. ViteHub finds the `server/content.ts` file that you write in the next step.

::

::tutorial-step{title="Define and read Content"}
## Define and read Content

Create `server/content.ts`. A Source tells Content where to find files. This one, `docs`, reads every Markdown file in the `docs` folder of your project:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source/glob'

export const content = defineContent({
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

- `glob()` finds files by a pattern. `cwd: 'docs'` is the folder to look in. `include: '**/*.md'` matches every `.md` file in it and in its subfolders.

Create the Markdown file that the route reads:

```md [docs/intro.md]
# Hello from Content

This page came from a local Source.
```

Create an API route that reads the file. `content.get('/intro')` finds `docs/intro.md` and returns it as a parsed document. With this route, you can check Content before you build a page.

```ts [server/api/guide.get.ts]
import { defineEventHandler } from 'h3'
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/intro')
})
```

You can also read documents from browser code. This file is optional. `createContentClient()` calls the `/api/content` routes that Content adds to your app, and it reads the same document:

```ts [app/utils/content.ts]
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient()

await content.get('/intro')
```

::

::tutorial-step{title="Read one document"}
## Read one document

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/guide
```

The response is the parsed `Hello from Content` document. This proves that the Source found `docs/intro.md` and that Content parsed it.

> [!NOTE]
> The `docs` Source is read-only. To change a document, you edit the file in your repository. To let people or Agents edit documents while the app runs, with drafts and publishing, add a [document collection](/docs/content/configure#document-collections).

::

## Next steps

- [Server API](/docs/content/server-api): see every Content method.
- [Content pages](/docs/ui/markdown#content-pages): show the document as a page with ViteHub UI Markdown.
- [Providers](/docs/content/configure#providers): add full-text search to your Sources.
- [Document collections](/docs/content/configure#document-collections): let people edit, save drafts, and publish.
