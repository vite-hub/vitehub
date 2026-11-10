---
title: Add presence and edits with ViteHub
description: Run Comments in a ViteHub app, see each other's cursors on a page, and edit a Content field in place.
layout: tutorial
navigation.title: With ViteHub
navigation.order: 9
icon: i-lucide-users
---

[Get started](/docs/comments/get-started) adds Comments to any Vite app with one plugin. A [ViteHub](/docs/getting-started) app adds presence, edits in place, the Console, and ViteHub MCP:

| Part | `comments()` alone | In a ViteHub app |
| --- | --- | --- |
| Threads, replies, resolve, pins | Yes | Yes |
| Where threads go | A SQLite file, Turso, or Cloudflare D1 | A ViteHub [Database](/docs/database): SQLite, libSQL, or D1 |
| Tables | Created when the server starts | Generated and applied with `vitehub database` |
| Who can comment | Sign in with GitHub, or guests on the dev server | Sign in with GitHub, [ViteHub Auth](/docs/auth), or your own login |
| Avatars and cursors of people on a page | No | Yes, with [Realtime](/docs/realtime) |
| Edit Content text in place | No | Yes, with [Content](/docs/content) |
| Comments section in the Console, MCP tools for Agents | No | Yes |

You will pin a comment, see a second browser's cursor, and edit a Content heading, then publish it from the Console.

You need Node.js 22.22 or newer, pnpm, and a Vite app with Vue and TypeScript. Run commands from its root. With a local SQLite Database and a memory room authority, you need no provider account.

::warning
This example lets anyone comment and edit, so keep it on your computer. [Decide who can comment](/docs/comments/configure#decide-who-can-comment) before you deploy.
::

::tutorial-step{title="Turn on Comments"}
## Turn on Comments

```bash [commands/install]
pnpm add vite-hub @vite-hub/comments @vite-hub/content @vite-hub/database @vite-hub/realtime drizzle-orm h3 zod
pnpm add -D drizzle-kit nitro
```

The Database stores threads. Realtime shows who is on each page, with rooms in this server process.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    database: true,
    realtime: { authority: 'memory' },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [
    vue(),
    vitehub({
      preset: 'node',
      database: true,
      realtime: { authority: 'memory' },
    }),
    nitro(),
  ],
})
```
::::

::::tabs-item{label="Vite"}
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
::::
:::

Add `server/comments.ts`, exporting the definition as `comments` or as default. Without the file, `vitehub({ comments: true })` turns Comments on with the default policy. The Console alone does not turn it on.

Without `authorize`, guests may comment only on the dev server. This policy allows everyone, so the steps also work in a preview build. People without an account comment as guests.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  // Local only: anyone may read, comment, and resolve.
  authorize: () => true,
})
```

Comments adds the tables `vitehub_comment_threads`, `vitehub_comment_messages`, and `vitehub_comment_counters` to the `default` Database. Generate the migration and apply it:

```bash [commands/migrate]
pnpm vitehub database generate
pnpm vitehub database migrate
```

::

::tutorial-step{title="Pin a comment"}
## Pin a comment

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/?vitehub`. `?vitehub` turns on comment mode, and a toolbar shows at the bottom. The `vitehub-tools` cookie keeps comment mode on other pages until you close the toolbar.

1. Press <kbd>C</kbd>, or select **Comment** in the toolbar. As a guest, type your name first. The browser remembers it.
2. Click a heading. A comment box opens there.
3. Type a comment and press <kbd>Enter</kbd>. A numbered pin marks the spot.
4. Select the pin, type `@` in a reply, and pick a person. With [Auth](/docs/auth), the list shows Auth users who may read the thread. Send it. The server checks the mention and passes the person to `onMention`. See [Notify mentioned people](/docs/comments/configure#notify-mentioned-people).
5. Select **Resolve**, the check mark on the thread. The pin goes away. To see it again, open the thread list from the toolbar and select **Resolved**.

Resize the window. The pin stays on the heading, because it is stored relative to the element, not the window.

Open `http://localhost:5173/` in a private window, without the query. That browser has no cookie, so the page comes without the overlay script.

::

::tutorial-step{title="See who else is on the page"}
## See who else is on the page

Open `http://localhost:5173/?vitehub` in a second browser or a private window. Use another name when you comment there.

- Each toolbar shows both people as avatars.
- Move the pointer in one browser. Its cursor moves on the same element in the other.
- Pin a comment in one browser. The pin shows in the other browser at once.

Both browsers share a Realtime room for the page, which holds only presence. Comments stay in the Database, and the other browser reloads them after each change.

::

::tutorial-step{title="Edit Content text in place"}
## Edit Content text in place

Add a Content singleton (a single document) with one text field. The `cms` preset stores it in a Workspace on the same Database and adds Blob.

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { singleton } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export default defineContent({
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
import content from '../content'

export default defineEventHandler(async () => {
  const about = await content.collection('about').get()
  return { title: about?.data.title ?? null }
})
```

Show it on the page. `contentField('about', 'title')` adds `data-content-field="about#title"` to the heading, so Comments knows which field the text comes from.

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
pnpm vitehub database generate
pnpm vitehub database migrate
```

The singleton has no document yet. Open the link that the dev server prints, which opens the app in the [Console](/docs/development/console#in-development). Select **Content**, then **Settings**, then **About**. Type a title and select **Publish**.

Open `http://localhost:5173/?vitehub` again. The heading shows the title.

1. Press <kbd>E</kbd>, or select **Edit** in the toolbar. Hover the heading. It gets an outline with its field address, `about#title`.
2. Click the heading. It becomes editable and shows the current draft.
3. Change the text and press <kbd>Enter</kbd>. Comments saves a Content draft, and the heading gets a **Draft** mark.
4. Reload the page. The heading shows the published title again, because pages read `published`.
5. Open **Content** in the Console. The About change is under **Needs publishing**. Publish it, then reload the page.

Pins on the heading now store the field `about#title`, so they follow it through layout changes.

::

## Next steps

- [Configure](/docs/comments/configure): access, sign-in, guests, mentions, notifications, and pull requests.
- [Hosts](/docs/comments/hosts): support on Node, Cloudflare, Vercel, and Netlify.
- [Server API](/docs/comments/server-api): read and change threads from server code.
