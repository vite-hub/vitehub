---
title: Realtime server API
description: Realtime imports, generated output, and durable checkpoints into Workspace.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports and generated output

| Import | Use |
| --- | --- |
| `defineRealtime` from `vite-hub/realtime` | Declare a discovered Realtime Definition. |
| `useRealtimeTiptap` from `vite-hub/realtime/vue` | Connect a Vue TipTap editor, presence, Workspace events, and checkpoints. |
| `createRealtimeHandler` from `vite-hub/realtime/server` | Build a handler for a manual server integration. The ViteHub integration generates this route for normal applications. |

The integration generates `.vitehub/nitro/realtime/registry.mjs` and
`.vitehub/nitro/realtime/handler.ts`. Treat both as inspectable build output,
not application imports.

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
durable Realtime authority also requires a durable Workspace Store. A checkpoint
retry stays bound to its original document and rejects if that document is
disconnected or replaced before the next attempt.
A checkpoint also rejects during a document switch until the Vue watcher creates
the new document.

A checkpoint succeeds only when its snapshot contains the canonical document
digest. If Workspace changed during publication, Realtime rebases onto the
remote head, preserves unrelated staged paths, and reconciles the room. A path
changed both locally and remotely remains a Workspace conflict.

Disabling the composable destroys its document provider, disconnects Workspace
events, clears queued notifications, and makes checkpoint calls reject with
`Realtime is disabled.` Enabling it reconnects both providers for the current
document.
