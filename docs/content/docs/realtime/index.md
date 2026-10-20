---
title: Realtime collaboration
navigation.title: Overview
description: Let several people edit one TipTap document at the same time, and save their changes to a file.
navigation.order: 1
icon: i-lucide-radio
---

::product-hero{tagline="Let several people edit one document at the same time, with live changes and automatic saves to a file." hosts="Cloudflare, Node, Docker"}
  :::product-files
  ```ts [server/realtime/docs.ts]
  import { defineRealtime } from 'vite-hub/realtime'

  // This file defines the docs room.
  export default defineRealtime({
    // Save each document to the docs Workspace
    document: { workspace: 'docs' },
    // Let the editor save a version on request
    history: {
      checkpoint: { message: 'Save document' },
    },
  })
  ```

  ```vue [src/App.vue]
  <script setup lang="ts">
  import { EditorContent, useEditor } from '@tiptap/vue-3'
  import {
    useRealtimeTiptap,
  } from 'vite-hub/realtime/vue'
  import PeopleList from './components/PeopleList.vue'

  // Everyone on this page edits the same file
  const realtime = useRealtimeTiptap('docs', 'welcome.md')
  const { people, history } = realtime
  const editor = useEditor({
    extensions: realtime.extensions.value,
  })
  </script>

  <template>
    <PeopleList :people="people" />
    <EditorContent :editor="editor" />
    <button @click="history.checkpoint()">
      Save version
    </button>
  </template>
  ```

  ```vue [src/components/PeopleList.vue]
  <script setup lang="ts">
  import type { RealtimePerson } from 'vite-hub/realtime'

  // Each person has a name and a color
  defineProps<{ people: RealtimePerson[] }>()
  </script>

  <template>
    <ul>
      <li
        v-for="person in people"
        :key="person.clientId"
        :style="{ color: person.color }"
      >
        {{ person.name }}
      </li>
    </ul>
  </template>
  ```

  ```ts [server/workspaces/docs.ts]
  import { defineWorkspace } from 'vite-hub/workspace'

  // The files that the docs room saves to.
  // Memory is for development only.
  export default defineWorkspace({
    store: { provider: 'memory' },
    rules: {
      '/**': { write: true, mediaType: 'text/markdown' },
    },
  })
  ```

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
        // Keep rooms in this server process
        realtime: { authority: 'memory' },
        workspace: true,
      }),
    ],
  })
  ```

  ```ts [Checkpoint]
  const [error, checkpoint] = await realtime.history.checkpoint()
  if (error) throw error

  checkpoint.document.body
  checkpoint.snapshot
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file defines a room" icon="i-lucide-file-code-2" to="/docs/realtime/get-started#configure-realtime"}
  Add a file to `server/realtime`. Its name is the name your editor connects to.
  :::

  :::product-feature-item{title="Works with your TipTap editor" icon="i-lucide-code-2" to="/docs/realtime/get-started#connect-a-tiptap-editor"}
  `useRealtimeTiptap()` gives your editor live sync and tells you if it is connected.
  :::

  :::product-feature-item{title="See who is editing" icon="i-lucide-users" to="/docs/realtime/server-api#carets"}
  Each person gets a name and a color. Their cursor shows in the editor of everyone else.
  :::

  :::product-feature-item{title="Saves on its own" icon="i-lucide-save" to="/docs/realtime/configure#control-saves"}
  Changes save to the file 2 seconds after the last edit, and when the last person leaves.
  :::

  :::product-feature-item{title="Decide who can join" icon="i-lucide-lock" to="/docs/realtime/server-api#identity-and-authorization"}
  Set `auth: true` to allow only signed-in people. `authorize()` decides who can read or edit each document.
  :::

  :::product-feature-item{title="Runs on Node or Cloudflare" icon="i-lucide-server" to="/docs/realtime/configure#host-support"}
  On Node, one server process holds every room. On Cloudflare, each document gets its own Durable Object.
  :::
::
