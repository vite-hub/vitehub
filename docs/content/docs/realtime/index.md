---
title: Realtime collaboration
navigation.title: Overview
description: Collaborative TipTap documents over Yjs, saved through Workspace or your own document adapter.
navigation.order: 1
icon: i-lucide-radio
---

::agent-only{skill="realtime"}
Use Realtime for collaborative state that changes while clients are connected. Realtime keeps room authority, document format, and durable checkpoints explicit.

Read [Get started](/docs/realtime/get-started), [Configure](/docs/realtime/configure), or [Server API](/docs/realtime/server-api). The Configure page describes host authority and persistence.

Choose Cloudflare authority for multi-instance production. Memory authority is single-process. Keep authentication and checkpoint retention in application policy.

Realtime is the collaboration layer for the supported document and editor
models. It does not replace Auth, Workspace persistence, or a general WebSocket
server.

Prove two clients joining, a concurrent edit, reconnect, and checkpoint recovery. Inspect the generated registry and handler for hosted output.
::

::product-hero{tagline="Collaborative TipTap editing over Yjs, saved to Workspace Markdown or your own storage, with rooms in memory on Node or Durable Objects on Cloudflare." hosts="Cloudflare, Node, Docker"}
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
  const [error, checkpoint] = await realtime.history.checkpoint()
  if (error) throw error

  checkpoint.document.body
  checkpoint.snapshot
  ```
  :::
::


::product-features
  :::product-feature-item{title="One composable for editor, presence, and sync" icon="i-lucide-code-2" to="/docs/realtime/get-started#connect-a-tiptap-editor"}
  Takes a Definition name and Workspace path; returns Vue refs.
  :::

  :::product-feature-item{title="Presence binds to a verified identity" icon="i-lucide-user-check" to="/docs/realtime/server-api#identity-and-authorization"}
  The ViteHub Auth session or your own `identify()`, with `authorize()` per document and mode.
  :::

  :::product-feature-item{title="Memory for one process, Durable Objects on Cloudflare" icon="i-lucide-cloud-cog" to="/docs/realtime/configure#choose-a-room-authority"}
  `memory` keeps rooms in one process; `cloudflare` uses Durable Objects.
  :::

  :::product-feature-item{title="Messages and rooms have fixed size limits" icon="i-lucide-gauge" to="/docs/realtime/configure#limits"}
  1 MiB per WebSocket message, 8 MiB of document state per room.
  :::

  :::product-feature-item{title="Rooms save themselves through a document adapter" icon="i-lucide-database" to="/docs/realtime/server-api#custom-document-adapters"}
  2 s after the last edit, at most 10 s, and when the last client leaves. Workspace is the default adapter.
  :::

  :::product-feature-item{title="Structured fields next to the body" icon="i-lucide-list" to="/docs/realtime/server-api#structured-documents"}
  A `fields` map with last-write-wins per field, and a server-written `status` map with issues.
  :::

  :::product-feature-item{title="One writer needs only Workspace" icon="i-lucide-folder-git-2" to="/docs/workspace"}
  Use Workspace alone when one writer changes files.
  :::
::
