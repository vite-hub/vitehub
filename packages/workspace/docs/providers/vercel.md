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

Configure Vercel Sandbox once at app level:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'

export default defineConfig({
  plugins: [hubSandbox(), hubWorkspace()],
  sandbox: {
    provider: 'vercel',
    runtime: 'node24',
  },
})
```

Then opt a workspace into sandbox execution with `runtime: 'sandbox'`:

```ts
export default defineWorkspace({
  store: {
    provider: 'vercel-blob',
    prefix: '.vitehub/workspaces',
    access: 'private',
  },
  runtime: 'sandbox',
  sources: {
    // ...
  },
})
```

```ts
import { useWorkspace } from '@vitehub/workspace'

const session = await useWorkspace('docs', { allowWrite: true }).open()

await session.exec('pnpm', ['test'])
await session.commit()
await session.close()
```

The workspace remains the file tree. On open, ViteHub reads the canonical store, writes the files into Vercel Sandbox, runs commands there, and commits filesystem changes back through the workspace store.
