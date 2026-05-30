---
title: Workspace context
description: Give agents source files and file-tree state without granting unrestricted filesystem access.
navigation.order: 25
icon: i-lucide-folder-search
---

Workspace context lets an Agent inspect source files, docs, generated files, or project state.

The Workspace is the file boundary. Capabilities decide which model-facing tools are exposed.

## Colocate workspace context

```ts [server/agents/docs/config.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
  instructions: 'Answer from the docs workspace. Say when the answer is not present.',
  model,
})
```

## Read mode first

Start with read mode. It gives the model enough visibility to inspect files without writing changes.

Use write mode only when the Agent is explicitly supposed to mutate Workspace files and the Workspace rules allow the target paths.

## Access scope

Use the Access Capability when invocation identity should narrow the visible Workspace Scope.

```ts
import { access, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    access({ roles }),
    workspaceShell({ mode: 'read' }),
  ],
  instructions,
  model,
})
```

Order matters. Access should run before Workspace-reading Capabilities so the scope is applied before tools are exposed.
