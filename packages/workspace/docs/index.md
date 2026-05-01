---
title: Workspace
description: Agent-oriented filesystem state for Vite and Nitro apps.
navigation.title: Workspace
navigation.order: 4
icon: i-lucide-folder-git-2
frameworks: [vite, nitro]
---

`@vitehub/workspace` is a ViteHub primitive for persistent file-tree state. Sources, loaders, and publishers populate and expose a workspace; sandbox providers run code against it when execution is needed.

Workspace owns files, snapshots, diffs, source ingestion, and publishing. `@vitehub/sandbox` owns isolated execution.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubWorkspace } from '@vitehub/workspace/vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {},
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/workspace/nitro'],
  workspace: {},
})
```
::

Define a workspace:

```ts [src/docs.workspace.ts]
import { defineWorkspace, loader, source } from '@vitehub/workspace'

export default defineWorkspace({
  sources: [
    source.glob({
      cwd: process.cwd(),
      include: ['README.md', 'docs/**/*.md'],
    }),
  ],
  loaders: [
    loader.files({
      include: ['**/*.md'],
    }),
  ],
})
```

In Nitro, place the same definition at `server/workspaces/docs.ts`.

Use it from server code:

```ts
import { useWorkspace } from '@vitehub/workspace'

const workspace = await useWorkspace('docs')

await workspace.sync()
await workspace.writeFile('generated/notes.md', 'Hello')

const files = await workspace.glob('**/*.md')
const diff = await workspace.diff()
```

## Provider Compatibility

The v1 provider is local-first. Cloudflare and Vercel compatibility is modeled in the public types and docs without pretending their storage products are interchangeable.

| Primitive | Workspace role |
| --- | --- |
| Cloudflare Artifacts | Future canonical versioned file-tree store. |
| Cloudflare Shell / Sandbox | Runtime filesystem and execution adapters. |
| Cloudflare R2 | Large-object spillover for workspace stores. |
| Vercel Blob | Object/file backing store, not Git-like workspace state. |
| Vercel Sandbox | Runtime/session persistence and snapshots for execution. |

## Sandbox Mounts

Workspaces expose mount metadata now so `@vitehub/sandbox` can attach later:

```ts
const mount = workspace.mount({
  mode: 'copy-on-write',
  target: '/workspace',
})
```

Mount modes are `read-only`, `read-write`, and `copy-on-write`. Writes are explicit: inspect `mount.diff()` and call `mount.commit()` or export a snapshot when an execution result should become workspace state.
