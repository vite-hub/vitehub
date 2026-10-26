---
title: Add presence and edits with ViteHub
description: Run Comments in a ViteHub app, see each other's cursors on a page, and edit a Content field in place.
layout: tutorial
navigation.title: With ViteHub
navigation.order: 3
icon: i-lucide-users
---

[Get started](/docs/comments/get-started) adds Comments to any Vite app with one plugin. In a [ViteHub](/docs/getting-started) app, Comments also gets presence, edits in place, the Console, and ViteHub MCP:

| Part | `comments()` alone | In a ViteHub app |
| --- | --- | --- |
| Threads, replies, resolve, pins | Yes | Yes |
| Where threads go | A SQLite file, or Cloudflare D1 | A ViteHub [Database](/docs/database): SQLite, libSQL, or D1 |
| Tables | Created when the server starts | Generated and applied with `vitehub db` |
| Who can comment | Sign in with GitHub, or guests on the dev server | Sign in with GitHub, [ViteHub Auth](/docs/auth), the [Console](/docs/development/console), or your own login |
| Avatars and cursors of the people on a page | No | Yes, with [Realtime](/docs/realtime) |
| Edit Content text in place | No | Yes, with [Content](/docs/content) |
| Comments section in the Console, MCP tools for Agents | No | Yes |

In this tutorial, you turn on Comments in a ViteHub app, pin a comment, open the page in a second browser to see each other's cursors, and change a Content heading on the page. Then you publish the draft from the Console.

You need Node.js 24.15 or newer, pnpm, and a Vite application that uses Vue and TypeScript. Run the commands from its root. This example uses a local SQLite Database and a memory room authority, and needs no provider account. It lets anyone comment and edit, so keep it on your computer. [Decide who can comment](/docs/comments/configure#decide-who-can-comment) before you deploy.

::tutorial-step{title="Turn on Comments"}
## Turn on Comments

```bash [commands/install]
pnpm add vite-hub h3 zod
pnpm add -D nitro
```

Comments stores threads in a Database. Realtime shows who is on each page. The memory authority keeps the presence rooms in this server process.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    vitehub({
      preset: 'node',
      database: true,
      realtime: { authority: 'memory' },
    }),
  ],
})
```

Add `server/comments.ts`. The file must export `comments`. Without `authorize`, guests may comment only on the dev server. This policy allows everyone, so the next steps also work in a preview build. People without an account comment as guests under a name they type.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  // Local only: anyone may read, comment, and resolve.
  authorize: () => true,
})
```

Comments adds the tables `vitehub_comment_threads` and `vitehub_comments` to the `default` Database. Generate the migration and apply it:

```bash [commands/migrate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

::

::tutorial-step{title="Pin a comment"}
## Pin a comment

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/?comments`. The `?comments` query turns on comment mode. A toolbar shows at the bottom of the page. The server also sets the `vitehub-comments` cookie, so other pages of the site keep comment mode until you close the toolbar.

1. Press <kbd>C</kbd>, or select **Comment** in the toolbar.
2. Click a heading on the page. A comment box opens at that point.
3. Type your name, then a comment, and press <kbd>⌘</kbd> <kbd>Enter</kbd>. A numbered pin shows where you clicked.
4. Select the pin, write a reply, and send it.
5. Select **Resolve**, the check mark on the thread. The pin goes away. Open the thread list from the toolbar and select **Show resolved** to see it again.

Resize the window. The pin stays on the heading, because it is stored relative to the element, not to the window.

Open `http://localhost:5173/` without the query in a private window. That browser has no cookie, so the server returns the page without the overlay script.

::

::tutorial-step{title="See who else is on the page"}
## See who else is on the page

Open `http://localhost:5173/?comments` in a second browser, or in a private window. Type another name when you write a comment there.

- The toolbar of each browser shows both people as avatars.
- Move the pointer in one browser. Its cursor moves in the other browser, on the same element.
- Pin a comment in one browser. The pin shows in the other browser at once.

The two browsers share a Realtime room for the page. The room holds only presence. Comments stay in the Database, and the other browser reads them again after each change.

::

::tutorial-step{title="Edit Content text in place"}
## Edit Content text in place

Add a Content singleton with one text field. The `cms` preset stores it in a Workspace on the same Database and adds Blob.

```ts [server/content.ts]
import { defineContent, singleton } from 'vite-hub/content'
import cms from 'vite-hub/content/presets/cms'
import { z } from 'zod'

export const content = defineContent({
  extends: cms,
  collections: {
    about: singleton({ path: 'about.json', fields: { title: z.string().min(1) } }),
  },
  // Local only: anyone may read, write, and publish.
  authorize: () => true,
})
```

Return the published title from a route:

```ts [server/api/about.get.ts]
import { defineEventHandler } from 'h3'
import { content } from '../content'

export default defineEventHandler(async () => {
  const about = await content.collection('about').get()
  return { title: about?.data.title ?? null }
})
```

Show it on the page. `contentField('about', 'title')` adds `data-content-field="about#title"` to the heading. This attribute tells Comments which field the text comes from.

```vue [src/App.vue]
<script setup lang="ts">
import { ref } from 'vue'
import { contentField } from 'vite-hub/content/client'

const title = ref<string | null>(null)
fetch('/api/about')
  .then(response => response.json())
  .then((about: { title: string | null }) => {
    title.value = about.title
  })
</script>

<template>
  <main>
    <h1 v-if="title" v-bind="contentField('about', 'title')">{{ title }}</h1>
    <p v-else>Publish the About title in the Console.</p>
    <p>Pin comments anywhere on this page.</p>
  </main>
</template>
```

Restart the dev server, then run the migrations again for the Content tables:

```bash [commands/migrate-content]
pnpm vitehub db generate
pnpm vitehub db migrate
```

The singleton has no document yet. Open `http://localhost:5173/_vitehub/content`, open **Settings**, then **About**. Type a title and select **Publish**.

Open `http://localhost:5173/?comments` again. The heading shows the title.

1. Press <kbd>E</kbd>, or select **Edit** in the toolbar. Move the pointer over the heading. It gets an outline with its field address, `about#title`.
2. Click the heading. It becomes editable and shows the current draft.
3. Change the text and press <kbd>Enter</kbd>. Comments saves a Content draft. The heading gets a **Draft** mark.
4. Reload the page. The heading shows the published title again, because pages read `published`.
5. Select **Review and publish** in the message, or open `/_vitehub/content`. The dashboard lists the About change under **Needs publishing**. Publish it, then reload the page.

Pins that you drop on the heading now store the field `about#title`. They stay on the heading when you move it to another place in the layout.

::

## Next steps

- [Configure](/docs/comments/configure): access, sign-in, guests, mentions, notifications, and pull requests.
- [Hosts](/docs/comments/hosts): what Node, Cloudflare, Vercel, and Netlify support.
- [Server API](/docs/comments/server-api): read and change threads from server code.
