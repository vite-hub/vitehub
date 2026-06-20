---
title: Workspace
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 7
icon: i-lucide-folder-git-2
---

Workspace is a named persistent file tree. Server code and agents can inspect, mutate, snapshot, diff, sync, or mount it only through the access you configure.

Workspace is not Blob or Source. Blob can back storage, Source can retrieve read-only content, but Workspace owns file-tree placement, persistence, rules, snapshots, diffs, and Source Sync.

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
