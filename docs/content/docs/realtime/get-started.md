---

title: Create your first collaborative room
description: Connect two TipTap editors to the same document and verify synchronization.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Open the same document in two browser tabs and edit it from either tab. Realtime synchronizes the editors through a shared room. A Workspace supplies the file path and receives the document when your app saves a checkpoint.

You need Node.js 24.15 or newer, pnpm, and a Vite application that uses Vue and TypeScript. Run the commands from its root. This example uses in-memory room and Workspace stores. Restarting the server loses their state. The room is public during this local check; enable Auth before admitting private documents.

::tutorial-step{title="Configure Realtime"}
## Configure Realtime

```bash [commands/install]
pnpm add vite-hub @tiptap/vue-3 h3
pnpm add -D nitro
```

Enable Workspace and Realtime. The memory authority is suitable for local
development and a single-process Node server. Keep the Vue plugin from your
application; Nitro consumes the generated WebSocket route configuration.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    nitro() as never,
    vitehub({
      preset: 'node',
      realtime: { authority: 'memory' },
      workspace: true,
    }),
  ],
})
```

Create a Realtime Definition under `server/realtime`. Its name comes from the
relative file path, so this file defines `docs`.

`document.workspace` names the Workspace used for checkpoints. The room name and file path together identify the shared document.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

Add the writable Workspace referenced by the Realtime Definition. This memory
store matches the local, single-process setup above.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Set `auth: true` on the Realtime Definition when every WebSocket and checkpoint
request must have a valid ViteHub Auth session. Connections are public when
`auth` is omitted.

::

::tutorial-step{title="Connect a TipTap editor"}
## Connect a TipTap editor

Both tabs must use the same Definition and path. The composable supplies TipTap's collaboration extensions and connection state.

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

Replace the scaffold's root view with this component. Destructure the status refs so Vue unwraps them in the template. The status line makes connection problems visible before you test typing. `useEditor()` disposes the editor when the component unmounts.

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

The composable connects to the generated WebSocket route. This room is public, so any client that can reach it can join. A presence label is not verified identity. Configure [Auth](/docs/auth) and set `auth: true` before using the room for private documents.
::

::tutorial-step{title="Verify synchronization"}
## Verify synchronization

Start the server and leave it running:

```bash [commands/dev]
pnpm vite dev
```

Open the local URL printed by Vite in two browser tabs. Both tabs should show
`Realtime: connected, Document synced`. Click the editor below the status in
one tab and type a sentence; it should appear in the other tab. Edit from the
second tab and verify that the first updates too. Both editors use the same
`docs` Definition and `guides/getting-started.md` document path.

Room updates synchronize the editors but do not write a Workspace file. An
explicit `realtime.history.checkpoint()` saves the current Markdown to the
Workspace. Both the room authority and Workspace store in this tutorial are
in memory, so restarting the server loses their state. Use a durable setup
before relying on documents surviving a restart.
::
