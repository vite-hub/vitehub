---
title: Workspace
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 7
icon: i-lucide-folder-git-2
---

Workspace is a named persistent file tree. Server code and agents can inspect, mutate, snapshot, diff, sync, or mount it only through the access you configure.

Workspace is not Blob or Source. Blob can back storage, Source can retrieve read-only content, but Workspace owns file-tree placement, persistence, rules, snapshots, diffs, and Source Sync.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/workspace
```

### Configure

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

### Start using it

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ include: ['docs/**/*.md'] }),
  },
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkspace` from `@vite-hub/workspace` | Declare a Workspace Definition. |
| `useWorkspace` from `@vite-hub/workspace` or `@vite-hub/workspace/runtime` | Read, write, diff, snapshot, sync, or start sessions for a Workspace. |
| `file`, `glob`, `github`, `markdown`, `mcpResources`, `fetch`, `custom` from `@vite-hub/workspace` | Declare Workspace Source Bindings. |
| `createWorkspaceTools` from `@vite-hub/workspace` or `@vite-hub/workspace/ai` | Build AI SDK tool surfaces from Workspace access. |
| `defineWorkspaceFileHandler`, `readWorkspaceFileResponse` from `@vite-hub/workspace/server` | Serve Workspace files from H3 routes. |
| `hubWorkspace` from `@vite-hub/workspace/vite` | Register Workspace discovery, generated types, assets, and runtime wiring. |
| `@vite-hub/workspace/loader`, `@vite-hub/workspace/publish`, `@vite-hub/workspace/test` | Use extension surfaces for loaders, publishers, and tests. |

Workspace runtime, definition, Source Binding, rule, hook, store, sync, facade, and session types are exported from `@vite-hub/workspace`.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

The Vite config key is `workspace`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workspace: false` | `false` | enabled | Disables Workspace integration. |
| `root` | `string` | `.vitehub/workspaces` | Runtime Workspace root directory. |
| `projectRoot` | `string` | ViteHub project root | Resolves server-side discovery from a custom project root. |
| `assets` | `WorkspaceModuleOptions['assets']` | package default | Controls build-time Workspace asset materialization. Accepts `false`, `true`, or explicit asset paths. |
| `store` | `WorkspaceStoreOptions` | `{ provider: 'local' }` | Default Workspace Store used by definitions that do not choose one. |

## Store providers

| Store | Configure with | Nuance |
| --- | --- | --- |
| Local | `{ provider: 'local', root?: string }` | Default filesystem-backed Workspace Store. |
| Memory | `{ provider: 'memory' }` | Test or ephemeral runtime storage. |
| Cloudflare artifacts | `{ provider: 'cloudflare-artifacts', binding?, namespace?, repo?, repoPrefix?, branch? }` | Hosted provider adapter behind generated runtime wiring. |
| Vercel Blob | `{ provider: 'vercel-blob', token?, prefix?, access? }` | Blob-backed Workspace Store. |
| GitHub | `{ provider: 'github', repo?, repository?, branch?, root?, token? }` | Repository-backed Workspace Store. |
| Custom | `WorkspaceStore` | Implement the Workspace Store contract directly. |

## Define a workspace

Create a Workspace Definition when the app needs durable file-tree behavior.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob, github } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({
      cwd: '.',
      include: ['README.md', 'docs/**/*.md'],
      instructions: 'Use these docs for public product behavior.',
    }),
    handbook: github({
      repo: 'acme/handbook',
      ref: 'main',
      root: 'support',
      mount: 'handbook',
      materialize: 'lazy',
      instructions: 'Use this handbook for support policy.',
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Source keys identify named origins inside the Workspace Source Map. A Source-Backed Path is read-only unless Workspace rules and runtime access allow writes elsewhere in the file tree.

## Workspace Definition options

`defineWorkspace()` accepts these top-level fields. The name comes from the discovered file path.

| Option | Type | Description |
| --- | --- | --- |
| `rootDir` | `string` | Source root used by loaders. |
| `sourceRootDir` | `string` | Source-specific root for Source helpers. |
| `store` | `WorkspaceStoreOptions` | Store for this Workspace. |
| `sources` | `Record<string, WorkspaceSourceInput>` | Workspace Source Bindings. |
| `rules` | `WorkspaceRules` | Read, write, media type, max size, commit, and validation policy by path pattern. |
| `hooks` | `WorkspaceHooks` | Write lifecycle hooks. |
| `plugins` | `WorkspacePlugin[]` | Bundled rules and hooks. |
| `loaders` | `WorkspaceLoader[]` | Build-time or runtime loaders. |
| `publish` | `WorkspacePublisher[]` | Publication behavior after snapshots or sync. |
| `runtime` | `'sandbox'` | Runtime mode hint for sandbox-backed execution. |

## Source Binding options

Workspace Source Bindings can wrap Source Package loaders and add Workspace behavior.

| Option | Type | Description |
| --- | --- | --- |
| `mount` | `WorkspaceSourceMount` | Where retrieved items appear in the Workspace file tree. Accepts a path string or Mount options. |
| `materialize` | `WorkspaceMaterializeMode` | Build-time, lazy, or disabled materialization. Values: `build`, `lazy`, `none`. |
| `cache` | `false or WorkspaceCacheOptions` | Source cache policy. Use `false` to disable caching or `{ maxAge }` to set a TTL. |
| `validate` | `WorkspaceValidateMode` | Request validation mode for API-backed Sources. Use `false` or `request`. |
| `sync` | `WorkspaceSourceSyncConfig` | Enables explicit Workspace Source Sync. Accepts `true`, `false`, or a sync policy. |
| `instructions` | `WorkspaceSourceInstructions` | Workspace-owned Source Instructions metadata. Accepts a string or a string array. |
| `resolve` | `WorkspaceSourceResolver` | Invocation-aware source resolution. |

## Use it at runtime

Read files from server code with `useWorkspace()`.

```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Request write access only at the call site that needs mutation.

```ts [server/api/drafts.post.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readBody<{ text: string }>(event)

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

## Runtime facade

`useWorkspace(name)` returns read access. `useWorkspace(name, { mode: 'write' })` returns write access.

| Surface | Methods |
| --- | --- |
| `workspace.fs` read mode | `readFile`, `stat`, `exists`, `list`, `glob`, `search` |
| `workspace.fs` write mode | read methods plus `writeFile`, `appendFile`, `mkdir`, `rm`, `movePath`, `copyPath` |
| writable facade | `diff`, `snapshot`, `materializeSources`, `sync`, `startSession`, `tools` |
| tools | default tools, `tools.inspect(options)`, `tools.write(options)`, `tools.none()` |

## Custom Sources and source resolution

Custom Sources can read existing materialized Workspace files through `ctx.workspaceFiles`. Use this when a Source needs previous generated output, such as a sync report or cached asset metadata, while producing the next materialized files. The view is read-only and does not expose Workspace Stores, provider adapters, snapshots, diffs, or Source materialization.

Sources can resolve their concrete origin, Mount, and Source Instructions for one invocation from trusted runtime context. Use this when the same Source key should point at a narrowed origin after Access has selected a Workspace Scope.

```ts
github(({ invocation }) => {
  const scope = invocation.context.get<{ customers: string[] }>('support.customerScope')
  const customer = scope?.customers[0]
  if (!customer)
    return false

  return {
    repo: 'quiverdk/ingestion',
    root: `dbt/${customer}`,
    mount: `ingestion/${customer}`,
    instructions: `Use this source only for ${customer} ingestion models.`,
  }
})
```

The resolver reads Agent Invocation Context Values and the Selected Workspace Scope, not model output. Access still enforces visibility, and scope-affecting resolved options are fingerprinted so source caches do not reuse data across scopes.

Resolved Sources are evaluated at invocation time and default to lazy materialization. A resolver can return a narrowed GitHub `repo`, `root`, `mount`, and `instructions` without also declaring build-time materialization or cache options; the resolved fingerprint includes the Selected Workspace Scope so one scope cannot reuse another scope's source data.

## Sync Sources

Workspace Source Sync is an explicit Workspace lifecycle operation. It reconciles selected Source-Backed Paths into the Workspace Store when a Source Sync Policy allows it.

```ts [server/tasks/sync-docs.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function syncDocs() {
  const workspace = useWorkspace('docs', { mode: 'write' })

  return workspace.sync({
    sources: ['handbook'],
    snapshot: { message: 'Sync handbook source' },
  })
}
```

Build and dev integrations own build-time Source materialization. Runtime `sync()` owns explicit Source Sync into Workspace Stores.

## Sessions and Shell

Use a Workspace Session when execution should operate on a materialized file tree and then produce a diff.

```ts [server/tasks/test-docs.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function testDocs() {
  const session = await useWorkspace('docs', { mode: 'write' }).startSession()

  await session.exec('pnpm', ['test'])
  const diff = await session.diff()
  await session.close()

  return diff
}
```

Workspace owns the file tree and commit behavior. [Shell](/docs/server-primitives/shell) owns controlled command sessions, and [Sandbox](/docs/server-primitives/sandbox) owns isolated execution providers.

## Provider output

The Workspace Package discovers Workspace Definitions, generates Workspace name types, prepares build-time assets, and wires Workspace Stores. A Workspace Store can use Blob, but the public file-tree boundary stays Workspace.

::note
The Nuxt Workspace handoff is only for hosted Workspace runtime setup and generated registry transport. It does not create Nitro-specific Workspace discovery, public provider store constructors, or a second Workspace authoring model.
::

Add generated types when you want `useWorkspace()` to narrow discovered Workspace names.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Connect it to Agents

Workspace is central to agents, but it is not automatically model-facing. Attach `workspaceShell()` when a model should inspect or edit Workspace files, and use `access()` when trusted invocation identity should select a Workspace Scope.

Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for the mental model and [Workspace context](/docs/agents/workspace-context) for Agent-specific composition.

## Next steps

- Use direct retrieval through [Source](/docs/server-primitives/source).
- Add command inspection with [Shell](/docs/server-primitives/shell).
- Expose file access to models through [Official capabilities](/docs/capabilities/official-capabilities).
