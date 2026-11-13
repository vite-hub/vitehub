---

title: Read your first Content document
description: Turn a local Markdown file into a Content document and read it from an API route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Content turns your Markdown files into documents that your app can read. A document has the headings and the body of the file, ready to show on a page.

In this tutorial, you write `docs/intro.md`. Then you read it as a document from an API route.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands in the root folder of the app. You need no account and no API key.

::tutorial-step{title="Install and configure"}
## Install and configure

Add Content to your app:

```bash pm [commands/install]
pnpm add @vite-hub/content
```

You do not change `nuxt.config.ts` or `vite.config.ts`. ViteHub finds the `server/content.ts` file that you write in the next step, and turns on Content.

::

::tutorial-step{title="Define and read Content"}
## Define and read Content

Create `server/content.ts`. It tells Content where your Markdown files are:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source'

export default defineContent({
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
import content from '../content'

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

`createContentClient()` calls the routes that Content adds to your server under `/api/content`. It has the same `get()` method.

::

::tutorial-step{title="Read one document"}
## Read one document

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal, and call your route:

```bash [commands/request]
curl http://localhost:3000/api/guide
```

The response is the `Hello from Content` document, as JSON:

```json [output/guide.json]
{"path":"/intro","data":{},"meta":{"issues":[],"issueRules":{},"readingTime":{"words":10,"minutes":1},"key":"docs/intro.md","source":"docs","stem":"intro","extension":".md","kind":"document","type":"text/markdown","partial":false,"hash":"5760765759451925"},"nodes":[["h1",{"id":"hello-from-content"},"Hello from Content"],["p",{},"This page came from a local Source."],["typeset-styles",{}]]}
```

`nodes` is the body of the file. The first node is the `# Hello from Content` heading.

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
