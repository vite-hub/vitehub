---
title: Workspace
description: Agent-oriented filesystem state for Vite and Nitro apps.
navigation.title: Workspace
navigation.order: 4
icon: i-lucide-folder-git-2
frameworks: [vite, nitro]
---

`@vitehub/workspace` is a ViteHub primitive for persistent file-tree state. Sources populate a workspace, build-time assets expose immutable context, and sandbox providers run code against it when execution is needed.

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
})
```
::

Define a workspace:

```ts [src/docs.workspace.ts]
import { defineWorkspace, source } from '@vitehub/workspace'
import * as workspaceSource from '@vitehub/workspace/source'

export default defineWorkspace({
  sources: {
    docs: workspaceSource.glob({
      cwd: process.cwd(),
      include: ['README.md', 'docs/**/*.md'],
    }),
    instructions: source.file({
      workspacePath: 'AGENTS.md',
      content: '# Instructions\nUse the workspace files as context.\n',
    }),
  },
})
```

In Nitro, place the same definition at `server/workspaces/docs.ts`.
Source entries are keyed. The key becomes the default workspace mount path, so the example above exposes files at `docs/**` and `instructions/**`.
For inline files, use `workspacePath` and `content`. For file-backed sources, use `path` for the source file and `workspacePath` for its path inside the mounted source.

Use it from server code:

```ts
import { useWorkspace } from '@vitehub/workspace'

const assets = useWorkspace('docs')
const workspace = useWorkspace('docs', { allowWrite: true })

const instructions = await assets.fs.readFile('instructions/AGENTS.md')
await workspace.fs.writeFile('generated/notes.md', 'Hello')

const files = await workspace.fs.glob('**/*.md')
```

For build-time, read-only context, enable `syncOnBuild` and read bundled assets:

```ts
import { useWorkspace } from '@vitehub/workspace'

const workspace = useWorkspace('docs')
const readme = await workspace.fs.readFile('docs/README.md')
const files = await workspace.fs.list('', { recursive: true })
```

For AI SDK agents, expose read-only workspace inspection tools:

```ts
import { useWorkspace } from '@vitehub/workspace'

const tools = useWorkspace('docs').tools()
```

The `shell` tool emulates safe file-inspection commands against workspace assets. It does not execute a real shell.
Read, list, and search commands are enabled by default. Write tools are exposed automatically when the facade is writable:

```ts
import { useWorkspace } from '@vitehub/workspace'

const tools = useWorkspace('docs', { allowWrite: true }).tools()
```

Applications that use `AGENTS.md` as the model instruction source should preload it through `useWorkspace(name).fs.readFile('instructions/AGENTS.md')`.

## Lazy materialization

Source mounts default to `materialize: 'build'`, which syncs files into the workspace store during build or explicit workspace sync.

Use `materialize: 'lazy'` when the agent only needs source files on demand:

```ts
export default defineWorkspace({
  sources: {
    docs: workspaceSource.github({
      repo: 'vite-hub/vitehub',
      ref: 'main',
      root: 'docs',
      materialize: 'lazy',
    }),
  },
})
```

Lazy sources are exposed virtually through the workspace API and workspace tools. `list`, `glob`, `find`, and `stat` use the source manifest without materializing every file. A file is fetched and written into the workspace store only when a read-oriented operation such as `readFile`, `cat`, `head`, or `tail` needs it.

The agent never receives a real filesystem mount. It only sees workspace tools such as `ls`, `find`, `cat`, `grep`, `readFile`, `writeFile`, `stat`, and `exists`, all backed by the workspace API.

Source-backed paths are read-only in this release. Write generated or editable files to normal workspace paths such as `artifacts/**` or `generated/**`.

Nitro supports both flat workspace files like `server/workspaces/docs.ts` and directory workspaces like `server/workspaces/docs/.config.ts`. Duplicate workspace names across those shapes are invalid.

## Hosted Providers

The v1 provider is local-first. Hosted runtimes select the smallest adapter that matches the deployment environment without pretending their storage products are interchangeable.

| Primitive | Workspace role |
| --- | --- |
| Cloudflare Artifacts | Future canonical versioned file-tree store. |
| Cloudflare Shell / Sandbox | Runtime filesystem and execution adapters. |
| Cloudflare R2 | Large-object spillover for workspace stores. |
| Memory | Default ephemeral store for unconfigured Vercel hosting. |
| Vercel Blob | Optional object/file backing store, not Git-like workspace state. |
| Vercel Sandbox | Runtime/session persistence and snapshots for execution. |
