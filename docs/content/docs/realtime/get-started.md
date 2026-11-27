---

title: Create your first collaborative room
description: Connect two TipTap editors to the same document and verify synchronization.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Realtime lets many people edit the same document at the same time, like a shared Google Doc. Each document lives in a room on your server. Every browser tab that opens the document joins that room and sees everyone else's edits right away.

In this tutorial, you open the same document in two browser tabs, type in one, and watch it sync to the other.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation), with Vue added: `@vitejs/plugin-vue`, an `index.html`, and a `src/main.ts` that mounts `src/App.vue`. Run every command from the app root. You need no account. This tutorial keeps everything in memory, so restarting the server clears your documents. The room is also public, so anyone who can reach your server can join. Turn on [Auth](/docs/auth) before you use Realtime for private documents.

::tutorial-step{title="Define Realtime"}
## Define Realtime

Install Realtime, Workspace, the TipTap Vue editor, and Drizzle. Realtime checks sessions through Auth, which uses your app's `drizzle-orm`:

```bash pm [commands/install]
pnpm add @vite-hub/realtime @vite-hub/workspace @tiptap/vue-3 drizzle-orm@1.0.0-rc.6
```

Realtime uses your app's TipTap and Yjs packages, so the editor and your TipTap components share one copy. Both pnpm and npm install them with Realtime. If you pin TipTap, use the same version, 3.31.4 or later, for every `@tiptap/*` package.

You need no extra ViteHub options. The two files that you create next turn on Realtime and Workspace. In a Vite app, keep the Vue plugin in `vite.config.ts`.

- In dev, Realtime keeps rooms in server memory. A Node deployment shares rooms across instances through Redis (`REDIS_URL`) or a Postgres Default Database. See [Configure](/docs/realtime/configure#choose-a-driver) for other drivers.
- A Workspace is a folder of files that your server can read and write. Realtime saves your documents there.

Create `server/realtime/docs.ts`. The file name is the name of the room setup: `docs`.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  access: 'public',
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

- `access: 'public'` lets anyone who opens the app read and edit each document. Before deploying, replace it with `authorize: true` or `authorize()`. See [Identity and authorization](/docs/realtime/server-api#identity-and-authorization).
- `document: { workspace: 'docs' }` saves each document as a Markdown file in the `docs` Workspace.
- `history.checkpoint` lets the client call `realtime.history.checkpoint()` to save a version in the Workspace history. `message` is the text of that version.

Create `server/workspaces/docs.ts` to define the `docs` Workspace where Realtime saves files:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { driver: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `driver: 'memory'` keeps files in memory, matching the rooms.
- `write: true` allows Realtime to write any Markdown file in the Workspace.

With `access: 'public'`, anyone can connect to the room. Replace it with `authorize: true` in `server/realtime/docs.ts` to accept only users who have signed in with ViteHub Auth.

::

::tutorial-step{title="Connect a TipTap editor"}
## Connect a TipTap editor

Create `src/composables/useDocumentEditor.ts` to connect a TipTap editor to the room.

```ts [src/composables/useDocumentEditor.ts]
import { useEditor } from '@tiptap/vue-3'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

export function useDocumentEditor() {
  const realtime = useRealtimeTiptap('docs', 'guides/getting-started.md')

  const editor = useEditor({
    extensions: realtime.extensions.value,
  })

  return { editor, realtime }
}
```

- `useRealtimeTiptap('docs', 'guides/getting-started.md')` joins the `docs` room for `guides/getting-started.md`. Two tabs edit the same document when they pass the same two values.
- `realtime.extensions` gives TipTap the extensions that sync edits.

Replace `src/App.vue` with this component. It shows the editor and a status line, so you see a connection problem before you start to type:

```vue [src/App.vue]
<script setup lang="ts">
import { EditorContent } from '@tiptap/vue-3'
import { useDocumentEditor } from './composables/useDocumentEditor'

const { editor, realtime } = useDocumentEditor()
const { status, synced } = realtime
</script>

<template>
  <main>
    <h1>Collaborative document</h1>
    <p role="status">
      Realtime: {{ status }}, {{ synced ? 'Document synced' : 'Waiting for sync' }}
    </p>
    <EditorContent :editor="editor" />
  </main>
</template>
```

- `status` shows whether the tab is connected to the room.
- `synced` shows whether the tab has the latest document state.

::

::tutorial-step{title="Verify synchronization"}
## Verify synchronization

Start the dev server:

```bash [commands/dev]
pnpm dev
```

Open `http://localhost:3000` in two browser tabs. Both tabs show `Realtime: connected, Document synced`.

Click the editor below the status line in one tab and type a sentence. It appears in the second tab right away. Type in the second tab and watch the first tab update too.

The tabs get each edit at once. Realtime saves the Markdown file to the Workspace 2 seconds after you stop typing, at most every 10 seconds while you type, and when the last tab closes. To change this timing, see [Configure](/docs/realtime/configure#control-saves).

::

## What happens when you deploy

This tutorial keeps rooms and files in memory, so a server restart clears them. Before deploying, choose a persistent Workspace store. To run several Node instances, use a Postgres Default Database or set `REDIS_URL` so they share rooms. [Configure](/docs/realtime/configure#host-support) lists what each host supports.

## Next steps

::card-group
:::card{title="Collaborative Editor" icon="i-lucide-users" to="/docs/ui/blocks/collaborative-editor"}
Show who else is editing, and whether the room is connected and saved.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/realtime/configure"}
Pick a room driver, control saves, and see every option.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/realtime/server-api"}
Add user identity, live cursors, and custom document storage.
:::
::
