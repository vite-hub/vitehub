---
title: Workspace and Sources
description: Understand persistent file-tree state, read-only origins, instruction coverage, and scoped visibility.
navigation.order: 7
icon: i-lucide-folder-git-2
---

A Workspace is a named persistent file tree. A Source is a named origin that exposes read-only addressable files, items, or controlled request access through a Workspace.

Workspace owns file-tree behavior. Source owns the origin. Mount only says where a Source appears inside the Workspace File Tree.

## Why it exists

Agents need inspectable files, but they should not receive the project filesystem by accident. Workspace makes the file boundary explicit, and Sources make external or local read-only origins addressable.

Workspace is also useful outside agents. Server code can read, write, snapshot, diff, and open Workspace sessions through the Workspace Runtime Surface.

## Define a workspace

Declare Sources inside the Workspace that owns their placement and policy.

Register the Workspace Vite Integration from `@vite-hub/workspace/vite` so ViteHub discovers Workspace Definitions.

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubWorkspace(),
  ],
})
```

```ts [server/workspaces/docs.ts]
import { defineWorkspace, file, glob, markdown } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: file({
      path: 'README.md',
    }),
    docs: glob({
      cwd: '.',
      include: ['docs/**/*.md'],
    }),
    supportPolicy: markdown({
      path: 'docs/support-policy.md',
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Source use guidance for model-backed Agents belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Current Source Instruction metadata does not grant access, change Workspace Scope, or make hidden Sources visible.

Agent inspection metadata warns when configured Sources are visible to an Agent but lack explicit instruction coverage.

## Agent access

An Agent with Workspace context does not automatically get unrestricted file tools. Attach a Capability such as `workspaceShell()` when the model should inspect or mutate Workspace files.

Workspace Scope narrows the visible Workspace File Tree for one Agent Invocation. Access can select that scope from trusted host, auth, or invocation context, but the model does not choose the scope.

## Inspect it

Use `useWorkspace()` from server code to inspect the runtime file tree. Add `.vitehub/types/**/*.d.ts` to `tsconfig.json` when you want generated Workspace names to narrow TypeScript types.

API-backed Sources can expose Source Request Descriptors at `.vitehub/sources/<sourceKey>.json` when they are visible through the selected scope. Those descriptors guide controlled shell requests without exposing credentials.

## Next steps

- Read [Workspace and Sources](/docs/server-primitives/workspace) in Server primitives.
- Read [Workspace context](/docs/agents/workspace-context) for agent-specific examples.
- Read [Capabilities API](/docs/concepts/capabilities-api) before exposing Workspace tools to a model.
