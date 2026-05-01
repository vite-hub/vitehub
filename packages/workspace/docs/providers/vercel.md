---
title: Vercel Workspace Compatibility
description: How @vitehub/workspace maps to Vercel Blob and Vercel Sandbox.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

`@vitehub/workspace` is local-first in v1. Vercel support is documented as compatibility direction, not a hosted canonical workspace store.

| Vercel primitive | Intended role |
| --- | --- |
| Vercel Blob | Object/file backing store for large files and generated artifacts. |
| Vercel Sandbox | Execution runtime with filesystem APIs, snapshots, and persistent sessions. |
| Future artifact-like store | Possible canonical versioned workspace provider if Vercel ships one. |

Vercel Blob is object storage, so it should not be treated as equivalent to Git-like workspace state. Vercel Sandbox persistence and snapshots are useful for runtime/session continuity, but workspace state should still be explicit: inspect diffs and commit or export changes intentionally.

Vercel runtime integration should use workspace mounts:

```ts
const mount = workspace.mount({
  mode: 'copy-on-write',
  target: '/vercel/sandbox',
})
```

The workspace remains the file tree. Sandbox runs code against that file tree.
