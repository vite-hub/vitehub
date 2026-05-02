---
title: Vercel Workspace Compatibility
description: How @vitehub/workspace maps to Vercel Blob and Vercel Sandbox.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

`@vitehub/workspace` defaults to an in-memory store on Vercel unless Blob is configured. Vercel does not provide a Miniflare-style local artifact environment, so the automatic hosted default stays ephemeral.

| Vercel primitive | Intended role |
| --- | --- |
| Memory | Default ephemeral workspace store for unconfigured Vercel hosting. |
| Vercel Blob | Optional object-backed workspace files, metadata, snapshots, and diffs. |
| Vercel Sandbox | Execution runtime with filesystem APIs, snapshots, and persistent sessions. |
| Future artifact-like store | Possible canonical versioned workspace provider if Vercel ships one. |

```ts
export default defineWorkspace({
  store: {
    provider: 'vercel-blob',
    prefix: '.vitehub/workspaces',
    access: 'private',
  },
})
```

When `provider: 'vercel-blob'` is configured, or `BLOB_READ_WRITE_TOKEN` is available during automatic resolution, the runtime reads `BLOB_READ_WRITE_TOKEN`. `snapshot()` writes a ViteHub manifest into the Blob store; it is not provider-native Git history. Vercel Sandbox persistence remains a runtime/session capability, not the identity of the workspace.

Vercel runtime integration should use workspace mounts:

```ts
const mount = workspace.mount({
  mode: 'copy-on-write',
  target: '/vercel/sandbox',
})
```

The workspace remains the file tree. Sandbox runs code against that file tree.
