---
title: Realtime collaboration
navigation.title: Overview
description: Sync collaborative Markdown through Workspace, choose a room authority, and create durable checkpoints.
navigation.order: 1
icon: i-lucide-radio
---

::product-hero{tagline="Collaborative TipTap editing of Workspace Markdown over Yjs, with rooms in memory on Node or Durable Objects on Cloudflare." hosts="Cloudflare, Node, Docker"}
  :::code-group
  ```ts [Editor]
  import { useEditor } from '@tiptap/vue-3'
  import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

  export function useDocumentEditor() {
    const realtime = useRealtimeTiptap('docs', 'guides/getting-started.md')

    const editor = useEditor({
      extensions: realtime.extensions.value,
    })

    realtime.people.value // Connected people
    realtime.status.value // connected, connecting, or disconnected
    realtime.synced.value // Whether the initial Yjs sync has completed

    return { editor, realtime }
  }
  ```

  ```ts [Definition]
  import { defineRealtime } from 'vite-hub/realtime'

  export default defineRealtime({
    document: { workspace: 'docs' },
    history: {
      checkpoint: { message: 'Save collaborative document' },
    },
  })
  ```

  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'node',
        realtime: { authority: 'memory' },
        workspace: true,
      }),
    ],
  })
  ```

  ```ts [Checkpoint]
  const checkpoint = await realtime.history.checkpoint()

  checkpoint.content
  checkpoint.snapshot
  ```
  :::
::


::product-features
  :::product-feature-item{title="One composable for editor, presence, and sync" icon="i-lucide-code-2" to="/docs/realtime/get-started#connect-a-tiptap-editor"}
  Takes a Definition name and Workspace path; returns Vue refs.
  :::

  :::product-feature-item{title="Presence can bind to an Auth session" icon="i-lucide-user-check" to="/docs/realtime/get-started"}
  With `auth: true`, presence uses the session; otherwise it is client-asserted.
  :::

  :::product-feature-item{title="Memory for one process, Durable Objects on Cloudflare" icon="i-lucide-cloud-cog" to="/docs/realtime/configure#choose-a-room-authority"}
  `memory` keeps rooms in one process; `cloudflare` uses Durable Objects.
  :::

  :::product-feature-item{title="Messages and rooms have fixed size limits" icon="i-lucide-gauge" to="/docs/realtime/configure#limits"}
  1 MiB per WebSocket message, 8 MiB of document state per room.
  :::

  :::product-feature-item{title="A checkpoint writes canonical Markdown to Workspace" icon="i-lucide-database" to="/docs/realtime/server-api#create-a-durable-checkpoint"}
  A checkpoint rebases when Workspace changed during publication.
  :::

  :::product-feature-item{title="One writer needs only Workspace" icon="i-lucide-folder-git-2" to="/docs/workspace"}
  Use Workspace alone when one writer changes files.
  :::
::
