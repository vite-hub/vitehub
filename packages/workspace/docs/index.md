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
      cwd: '.',
      include: ['README.md', 'docs/**/*.md'],
    }),
    instructions: source.file('AGENTS.md'),
  },
})
```

In Nitro, place the same definition at `server/workspaces/docs.ts`.
Source entries are named origins. Tree sources use the source key as the default workspace mount path, so the example above exposes the glob source at `docs/**`.
Single-file sources mount at the workspace root by default, so `source.file('AGENTS.md')` exposes `AGENTS.md`, not `instructions/AGENTS.md`.
For colocated workspace definitions, local file paths are relative to the adjacent `workspace/` directory when it exists, otherwise the definition directory.
For inline files, use `workspacePath` and `content`. For file-backed sources, use `path` for the source file; `workspacePath` overrides its path inside the mounted source.
Directory workspaces and colocated agent workspaces do not ingest sibling files automatically; declare every file origin through `sources`.

Workspace rules are path-scoped write policy, similar in shape to Nitro route rules:

```ts [src/docs.workspace.ts]
import { defineWorkspace } from '@vitehub/workspace'

export default defineWorkspace({
  rules: {
    '/**': { write: false },
    '/CONTEXT.md': { write: true, mediaType: 'text/markdown' },
    '/docs/adr/**': { write: true, maxBytes: '1mb' },
    '/generated/**': { write: true },
  },
})
```

Rules are enforced before writes reach the workspace store. Reusable workspace plugins can contribute the same `rules` and write lifecycle `hooks` that users can define inline.

Use it from server code:

```ts
import { useWorkspace } from '@vitehub/workspace'

const assets = useWorkspace('docs')
const workspace = useWorkspace('docs', { allowWrite: true })

const instructions = await assets.fs.readFile('instructions/AGENTS.md')
await workspace.fs.writeFile('generated/notes.md', 'Hello')

const files = await workspace.fs.glob('**/*.md')
```

Build-time, read-only context is bundled into an asset registry during production builds by default. Use `workspace.assets` in app config when you want to select or disable bundled workspaces:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubWorkspace } from '@vitehub/workspace/vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {
    assets: ['docs'],
  },
})
```

Read bundled assets through the same workspace facade:

```ts
import { useWorkspace } from '@vitehub/workspace'

const workspace = useWorkspace('docs')
const readme = await workspace.fs.readFile('docs/README.md')
const files = await workspace.fs.list('', { recursive: true })
```

For AI SDK agents, expose read-only workspace inspection tools explicitly:

```ts
import { useWorkspace } from '@vitehub/workspace'

const tools = useWorkspace('docs').tools.inspect()
```

The `shell` tool is a restricted workspace shell for inspection. It operates over files mounted at `/workspace`, and its AI SDK description includes the supported command forms and examples.

Read, list, and search commands are enabled by default in the inspection preset. Use explicit presets when choosing what a model can access:

```ts
import { useWorkspace } from '@vitehub/workspace'

const readOnlyTools = useWorkspace('docs').tools.inspect()
const noTools = useWorkspace('docs').tools.none()
const writeTools = useWorkspace('docs', { allowWrite: true }).tools.write()
```

- `inspect()` exposes the read-only `shell` tool.
- `none()` returns an empty tool set.
- `write()` exposes read tools plus structured write tools, and requires `useWorkspace(name, { allowWrite: true })`.

Applications that use `AGENTS.md` as the model instruction source should load it through `useWorkspace(name).fs.readFile('instructions/AGENTS.md')` or an agent `instructions` resolver. Keep detailed shell command syntax in tool metadata instead of duplicating it in app instructions.

## Sandbox runtime

Set `runtime: 'sandbox'` when a workspace needs commands, package managers, compilers, or provider-managed filesystem execution:

```ts [src/docs.workspace.ts]
import { defineWorkspace } from '@vitehub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  runtime: 'sandbox',
  sources: {
    // ...
  },
})
```

Sandbox provider selection belongs to app config, not `workspace.open()`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'

export default defineConfig({
  plugins: [hubSandbox(), hubWorkspace()],
  sandbox: {
    provider: 'cloudflare',
    binding: 'SANDBOX',
    sandboxId: 'app-sandbox',
  },
})
```

```ts
import { useWorkspace } from '@vitehub/workspace'

const session = await useWorkspace('docs', { allowWrite: true }).open()

await session.exec('pnpm', ['test'])
const changes = await session.diff()
await session.commit({ message: 'Apply generated changes' })
await session.close()
```

On open, ViteHub syncs the readable workspace contents into the configured sandbox provider. Writes happen in the sandbox session. `diff()` compares sandbox filesystem changes against the workspace store, and `commit()` persists sandbox changes back to that store.

## Lazy materialization

Sources default to `materialize: 'build'`, which syncs files into the workspace store during build or explicit workspace sync. This is separate from `workspace.assets`, which controls whether synced workspace files are also emitted into the read-only build asset registry.

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

Nitro supports both flat workspace files like `server/workspaces/docs.ts` and directory workspaces like `server/workspaces/docs/config.ts`. Agents can also declare colocated workspaces through `server/agents/docs/config.ts`, but sibling files still require explicit Sources. Duplicate workspace names across those shapes are invalid.

## Hosted Providers

The v1 provider is local-first. Hosted runtimes select the smallest adapter that matches the deployment environment without pretending their storage products are interchangeable.

| Primitive | Workspace role |
| --- | --- |
| Cloudflare Artifacts | Future canonical versioned file-tree store. |
| Cloudflare Sandbox | Runtime filesystem and execution adapter. |
| Cloudflare R2 | Large-object spillover for workspace stores. |
| Memory | Default ephemeral store for unconfigured Vercel hosting. |
| Vercel Blob | Optional object/file backing store, not Git-like workspace state. |
| Vercel Sandbox | Runtime/session persistence and snapshots for execution. |
