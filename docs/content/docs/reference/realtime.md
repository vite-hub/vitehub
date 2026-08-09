---
title: Realtime checkpoints
description: Capture canonical Workspace content and control Vue Realtime provider lifecycle.
navigation.order: 52
icon: i-lucide-radio
---

The Vue Realtime composable keeps collaborative editing local while making a
checkpoint an explicit durable boundary. A successful checkpoint returns the
canonical Markdown read from Workspace together with the snapshot that contains
that document digest:

```ts
const realtime = useRealtimeTiptap('docs', () => route.params.path, {
  enabled: () => route.name === 'editor',
})

const checkpoint = await realtime.history.checkpoint()
checkpoint.content
checkpoint.snapshot
```

`history.pending` is a computed ref. It remains `true` until every overlapping
checkpoint request settles. Use it for checkpoint UX without maintaining a
second request counter in application code.

`enabled` accepts a boolean ref or getter. Disabling the composable destroys its
document provider, disconnects its Workspace-event provider, drops queued
Workspace notifications, and makes checkpoint calls reject with
`Realtime is disabled.` Enabling it reconnects both providers for the current
document.

A checkpoint is acknowledged only when its snapshot contains the digest of the
canonical document captured after the conditional Workspace write. If the
Workspace changes during publication, Realtime rebases the shared Store onto
the new remote head, preserves unrelated staged paths, and takes the remote
version of the active document before reconciling the room. Another path that
changed both locally and remotely remains an explicit Workspace conflict.
