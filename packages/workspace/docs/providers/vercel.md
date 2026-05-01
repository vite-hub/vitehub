---
title: Vercel Workspace Compatibility
description: How @vitehub/workspace maps to Vercel Blob and Vercel Sandbox.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

`@vitehub/workspace` supports Vercel Blob as the hosted v1 workspace store. Blob is object storage, so ViteHub adds workspace manifests for snapshots and diffs.

| Vercel primitive | Intended role |
| --- | --- |
| Vercel Blob | Object-backed workspace files, metadata, snapshots, and diffs. |
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

The runtime reads `BLOB_READ_WRITE_TOKEN`. `snapshot()` writes a ViteHub manifest into the Blob store; it is not provider-native Git history. Vercel Sandbox persistence remains a runtime/session capability, not the identity of the workspace.

Vercel runtime integration should use workspace mounts:

```ts
const mount = workspace.mount({
  mode: 'copy-on-write',
  target: '/vercel/sandbox',
})
```

The workspace remains the file tree. Sandbox runs code against that file tree.
