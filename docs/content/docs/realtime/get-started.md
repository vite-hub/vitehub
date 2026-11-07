---
title: Create your first collaborative room
description: Connect two TipTap editors to the same document and verify synchronization.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You open the same document in two browser tabs. When you type in one tab, the text shows in the other tab. ViteHub also saves the document as a Markdown file.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app that uses Vue and TypeScript. Run every command from its root folder.

You do not need a cloud account or a database.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add vite-hub @vite-hub/realtime @vite-hub/workspace @tiptap/vue-3 h3
pnpm add -D nitro
```

`@vite-hub/realtime` syncs the editors. `@vite-hub/workspace` stores the Markdown file. `@tiptap/vue-3` is the text editor. `nitro` and `h3` run the server that the tabs connect to.

Add the `vitehub` plugin to `vite.config.ts`. Keep the `vue()` plugin that your app already has.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    vitehub({
      preset: 'node',
      realtime: { authority: 'memory' },
      workspace: true,
    }),
  ],
})
```

- `preset: 'node'` builds the app for a plain Node.js server.
- `realtime: { authority: 'memory' }` turns on Realtime. The authority is the place that keeps the live state of each room. A room is the shared session that all tabs of one document join. `memory` keeps rooms in the server process. It works only on one Node.js server.
- `workspace: true` turns on Workspace. A Workspace is a folder of files that the server can read and write.

::

::tutorial-step{title="Create the room and the folder"}
## Create the room and the folder

Create `server/realtime/docs.ts`. ViteHub reads each file in `server/realtime/` as one type of room, and uses the file name as its name. This file creates `docs`.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

- `document: { workspace: 'docs' }` saves each document as a file in the `docs` Workspace. The room name and the file path together point to one document.
- `history.checkpoint.message` is the message of each saved version in the history.

Create `server/workspaces/docs.ts`. This is the `docs` Workspace that the room saves to:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `store: { provider: 'memory' }` keeps the files in the server process.
- `rules` lets the server write every file (`/**`) as Markdown.

> [!NOTE]
> The room and the Workspace both keep data in memory. When you restart the server, you lose the documents. For data that stays after a restart, see [Configure](/docs/realtime/configure#choose-a-room-authority).

::

::tutorial-step{title="Connect a TipTap editor"}
## Connect a TipTap editor

Create `src/composables/useDocumentEditor.ts`. `useRealtimeTiptap()` connects to the `docs` room and opens the file `guides/getting-started.md`. It gives TipTap the extensions that sync the text, and it gives you the connection status.

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

Replace `src/App.vue` with this component. It shows the editor and a status line. The status line tells you if the connection fails before you start to type.

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

`const { status, synced } = realtime` takes the two status values out of `realtime`, so the template can show them directly.

> [!NOTE]
> This room is public. Any client that can reach the server can join it and edit. To allow only signed-in users, configure [Auth](/docs/auth) and set `auth: true` in `server/realtime/docs.ts`.

::

::tutorial-step{title="Type in two tabs"}
## Type in two tabs

Start the dev server and keep it running:

```bash [commands/dev]
pnpm vite dev
```

Open the local URL that Vite prints in two browser tabs. Both tabs show `Realtime: connected, Document synced`. This proves that both tabs joined the room.

Click the editor in one tab and type a sentence. The sentence shows in the other tab. Then type in the second tab. The first tab updates too. This proves that the room syncs the editors in both directions.

The tabs sync at once. The Markdown file saves later:

- 2 seconds after you stop typing
- at most every 10 seconds while you type
- when you close the last tab

`realtime.history.checkpoint()` also saves the file as a version in the Workspace history.

::

## Next steps

- [Collaborative Editor](/docs/ui/blocks/collaborative-editor): show who else is editing, and whether the room is connected and saved.
- [Configure](/docs/realtime/configure): choose a room authority that keeps data after a restart.
- [Server API](/docs/realtime/server-api#identity-and-authorization): check who can join a room.
