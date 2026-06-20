---
title: Workspace and Sources
description: Build persistent file-tree state from source origins, snapshots, diffs, and sandbox sessions.
navigation.title: Workspace
navigation.order: 7
icon: i-lucide-folder-git-2
---

Workspace is a persistent file tree. Sources populate that tree. Server code and agents can inspect or mutate it only through the access you configure.

Use Workspace when the app needs files, project context, source ingestion, snapshots, diffs, or publishable changes. Use Blob when you only need object storage.

## Define a workspace

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
      materialize: 'lazy',
      instructions: 'Use this handbook for support policy and escalation rules.',
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Source keys are named origins. A glob, file, fetch, or GitHub source is not automatically editable just because it appears in a Workspace.

`instructions` is optional model-facing guidance for agents that use the Workspace. It does not grant access or change which files are visible.

Custom Sources can read existing materialized Workspace files through `ctx.workspaceFiles`. Use this when a Source needs previous generated output, such as a sync report or cached asset metadata, while producing the next materialized files. The view is read-only and does not expose Workspace Stores, provider adapters, snapshots, diffs, or Source materialization.

## Invocation-scoped source resolution

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

## Use a workspace from server code

```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Request write access only at the call site that needs it.

```ts
const workspace = useWorkspace('docs', { mode: 'write' })
await workspace.fs.writeFile('drafts/summary.md', '# Summary\n')
```

## TypeScript names

`hubWorkspace()` writes generated Workspace name types to `.vitehub/types/workspace.d.ts`. Add that generated directory to your `tsconfig.json` when you want `useWorkspace()` and related helpers to narrow to discovered Workspace names.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

Without that include, runtime behavior is unchanged, but Workspace names fall back to `string` in TypeScript.

## Rules

Workspace rules are path-scoped write policy.

```ts
rules: {
  '/**': { write: false },
  '/drafts/**': { write: true, maxBytes: '1mb' },
  '/generated/**': { write: true },
}
```

Rules are enforced before writes reach the store. They are also the boundary that agent-facing Workspace Capabilities must respect.

## Sandbox sessions

When files need to be executed, pair Workspace with Sandbox.

```ts
const session = await useWorkspace('docs', { mode: 'write' }).startSession()

await session.exec('pnpm', ['test'])
const changes = await session.diff()
await session.commit({ message: 'Apply generated docs update' })
await session.close()
```

Workspace owns the file tree and diff. Sandbox owns isolated command execution.

## Agent context

Workspace is central to agents, but it is not automatically model-facing. To let an agent inspect files, attach a Workspace Capability such as `workspaceShell()`.

Read [Workspace context for agents](/docs/agents/workspace-context) for the agent-specific model.
