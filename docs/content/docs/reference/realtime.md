---
title: Realtime collaboration
description: Sync collaborative Markdown through Workspace, choose a room authority, and create durable checkpoints.
navigation.order: 54
icon: i-lucide-radio
---

Realtime connects TipTap editors through Yjs while keeping canonical Markdown in
a [Workspace](/docs/server-primitives/workspace). Use it when several clients
need to edit the same Workspace document and see presence, connection state, and
external file changes.

## Configure Realtime

Install the ViteHub distribution in a Vue or Nuxt application.

```bash [Terminal]
pnpm add vite-hub @tiptap/vue-3
```

Enable Workspace and Realtime. The memory authority is suitable for local
development and a single-process Node server.

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

Create a Realtime Definition under `server/realtime`. Its name comes from the
relative file path, so this file defines `docs`.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

The referenced Workspace Definition must exist and allow writes. Set
`auth: true` on the Realtime Definition when every WebSocket and checkpoint
request must have a valid ViteHub Auth session. Connections are public when
`auth` is omitted.

## Connect a TipTap editor

Call `useRealtimeTiptap()` with the Realtime Definition name and a safe
Workspace path. Its editor state is exposed as Vue refs.

```ts [app/composables/useDocumentEditor.ts]
import { useEditor } from '@tiptap/vue-3'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

const realtime = useRealtimeTiptap('docs', 'guides/getting-started.md')

const editor = useEditor({
  extensions: realtime.extensions.value,
})

realtime.people.value // Connected people
realtime.status.value // connected, connecting, or disconnected
realtime.synced.value // Whether the initial Yjs sync has completed
```

The composable connects to ViteHub's generated
`/api/_vitehub/realtime/**` WebSocket route. With `auth: true`, the server
verifies the ViteHub Auth session and binds that user to presence updates. In a
public Definition, presence identity is client-asserted—even if the client has a
session—and must not be used as an authorization or verified-identity boundary.

`realtime.workspace.change` reports file changes published by other Workspace
clients. Call `realtime.workspace.notify(change)` after an application changes
a Workspace path outside the collaborative editor.

## Create a durable checkpoint

A room update is collaborative state, not a Workspace write. Create a checkpoint
when the current document must become canonical Markdown in Workspace.

```ts
const checkpoint = await realtime.history.checkpoint()

checkpoint.content
checkpoint.snapshot
```

`history.pending` remains `true` until every overlapping checkpoint request
settles. Checkpoints require a Workspace Store with conditional writes. A
durable Realtime authority also requires a durable Workspace Store.

A checkpoint succeeds only when its snapshot contains the canonical document
digest. If Workspace changed during publication, Realtime rebases onto the
remote head, preserves unrelated staged paths, and reconciles the room. A path
changed both locally and remotely remains a Workspace conflict.

Disabling the composable destroys its document provider, disconnects Workspace
events, clears queued notifications, and makes checkpoint calls reject with
`Realtime is disabled.` Enabling it reconnects both providers for the current
document.

## Choose a room authority

| Authority | Use |
| --- | --- |
| `auto` | Uses Cloudflare Durable Objects whenever the resolved preset is Cloudflare, including development. Other development presets use memory; other production builds fail until an authority is selected. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration. Use it for durable, distributed rooms on Cloudflare. |
| `memory` | Keeps rooms in one process. Use it for local development or an explicitly single-process Node deployment. Room state is lost when the process stops. |

ViteHub rejects the memory authority on distributed host presets. It also
rejects a Cloudflare authority paired with another deployment preset.

## Limits

| Boundary | Limit |
| --- | --- |
| WebSocket message | 1 MiB |
| Document state per room | 8 MiB |
| Awareness state per room | 8 MiB |
| Awareness clients per peer | 1,024 |
| Active rooms under the memory authority | 128, with inactive clean rooms evicted first |

## Public imports and generated output

| Import | Use |
| --- | --- |
| `defineRealtime` from `vite-hub/realtime` | Declare a discovered Realtime Definition. |
| `useRealtimeTiptap` from `vite-hub/realtime/vue` | Connect a Vue TipTap editor, presence, Workspace events, and checkpoints. |
| `createRealtimeHandler` from `vite-hub/realtime/server` | Build a handler for a manual server integration. The ViteHub integration generates this route for normal applications. |

The integration generates `.vitehub/nitro/realtime/registry.mjs` and
`.vitehub/nitro/realtime/handler.ts`. Treat both as inspectable build output,
not application imports.

## Related

- [Workspace](/docs/server-primitives/workspace)
- [Auth](/docs/server-primitives/auth)
- [File conventions](/docs/reference/file-conventions)
- [Config options](/docs/reference/config-options)
- [Generated files](/docs/development/generated-files)
