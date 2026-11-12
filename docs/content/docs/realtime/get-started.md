---

title: Create your first collaborative room
description: Connect two TipTap editors to the same document and verify synchronization.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Realtime lets many people edit the same document at the same time, like a shared Google Doc. Each document lives in a room on your server. Every browser that opens the document joins the room and sees the changes of the others at once.

In this tutorial, you open the same document in two browser tabs. You type in one tab and see the text appear in the other.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation), with Vue added: `@vitejs/plugin-vue`, an `index.html`, and a `src/main.ts` that mounts `src/App.vue`. Run every command from the app root. You need no account. This tutorial keeps everything in memory, so a server restart loses your documents. The room is also public: anyone who can reach your server can join it. Turn on [Auth](/docs/auth) before you use it for private documents.

::tutorial-step{title="Configure Realtime"}
## Configure Realtime

Add Realtime, Workspace, and the TipTap editor for Vue to your app:

```bash pm [commands/install]
pnpm add @vite-hub/realtime @vite-hub/workspace @tiptap/vue-3
```

Then add `realtime` and `workspace` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep the other options of your app. In Vite, also keep the Vue plugin.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    realtime: { authority: 'memory' },
    workspace: true,
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
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
    }), nitro(),
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
      realtime: { authority: 'memory' },
      workspace: true,
    }),
  ],
})
```
::::
:::

- `authority: 'memory'` keeps the rooms in the memory of your server. Use it for local work and for one Node server. See [Configure](/docs/realtime/configure#choose-a-room-authority) for the other choices.
- `workspace: true` turns on Workspace. A Workspace is a folder of files that your server can read and write. Realtime saves your documents there.

Create `server/realtime/docs.ts`. The file name is the name of the room setup: `docs`.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

- `document: { workspace: 'docs' }` saves each document as a Markdown file in the `docs` Workspace.
- `history.checkpoint` lets the page call `realtime.history.checkpoint()` to save a version in the Workspace history. `message` is the text of that version.

Create `server/workspaces/docs.ts`. This is the `docs` Workspace that Realtime saves to:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `provider: 'memory'` keeps the files in memory, like the rooms.
- `write: true` lets Realtime write any Markdown file in the Workspace.

Without an `auth` option, anyone can connect to the room. Set `auth: true` in `server/realtime/docs.ts` to accept only users who have signed in with ViteHub Auth.

::

::tutorial-step{title="Connect a TipTap editor"}
## Connect a TipTap editor

Create `src/composables/useDocumentEditor.ts`. It makes a TipTap editor that is connected to the room.

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

- `useRealtimeTiptap('docs', 'guides/getting-started.md')` joins the `docs` room setup for the file `guides/getting-started.md`. Two tabs edit the same document when they use the same two values.
- `realtime.extensions` gives TipTap what it needs to share the edits.

Replace `src/App.vue` with this component. It shows the editor and a status line, so you see a connection problem before you start to type.

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

- `status` tells you if the tab is connected to the room.
- `synced` tells you if the tab has the latest version of the document.

::

::tutorial-step{title="Verify synchronization"}
## Verify synchronization

Start the dev server:

```bash [commands/dev]
pnpm dev
```

Open `http://localhost:3000` in two browser tabs. Both tabs show `Realtime: connected, Document synced`.

Click the editor below the status line in one tab, and type a sentence. The sentence appears in the other tab. Type in the second tab, and the first tab changes too.

The tabs get each edit at once. Realtime saves the Markdown file to the Workspace 2 seconds after you stop typing. While you type, it saves at most every 10 seconds. It also saves when the last tab closes. To change this timing, see [Configure](/docs/realtime/configure#control-saves).

::

## What happens when you deploy

In this tutorial, the rooms and the files are in memory. A server restart loses them, and two servers do not share them. Before you deploy, pick a room authority and a Workspace store that keep their data. [Configure](/docs/realtime/configure#host-support) shows what each host supports.

## Next steps

::card-group
:::card{title="Collaborative Editor" icon="i-lucide-users" to="/docs/ui/blocks/collaborative-editor"}
Show who else is editing, and whether the room is connected and saved.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/realtime/configure"}
Pick a room authority, control saves, and see every option.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/realtime/server-api"}
Add identity, carets, and your own document storage.
:::
::
