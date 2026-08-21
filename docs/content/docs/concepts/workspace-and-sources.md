---
title: Workspace and Sources
description: Understand how persistent files differ from read-only origins.
navigation.order: 13
icon: i-lucide-folder-git-2
---

A Workspace is a named file tree that can persist changes. A Source provides read-only files, items, or controlled requests. Mounting a Source makes its content available inside a Workspace.

Use a Workspace for files, rules, sessions, snapshots, and writes. Use a Source to read content from a local file, remote service, API, or another provider.

## Workspace and Source have different roles

| | Workspace | Source |
| --- | --- | --- |
| Provides | A file tree and file operations | Read-only content from an origin |
| Writes | Can allow writes through Workspace rules | Does not accept Workspace writes |
| Placement | Defines the tree and mount points | Appears at a mount inside a Workspace |
| Agent access | Requires Workspace context and a selected Capability | Visible only within the selected Workspace Scope |

## Define the tree and its origins

```ts [server/workspaces/docs.ts]
import { defineWorkspace, file, glob } from 'vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: file({ path: 'README.md' }),
    docs: glob({ cwd: '.', include: ['docs/**/*.md'] }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

The Workspace defines the rules and tree. The Sources provide the content mounted into that tree.

## Agent access is another choice

Workspace context does not give an Agent file tools. Attach a Capability such as `workspaceShell()` when the Agent needs to read or change Workspace files.

Workspace Scope narrows the visible tree for one invocation. The trusted host or invocation context selects that scope. The model cannot widen it.

## Inspect the result

Use `useWorkspace()` from server code to inspect the file tree. Generated Workspace and Source metadata lists discovered names and request descriptors without exposing provider credentials.

Read [Workspace](/docs/server-primitives/workspace), [Source](/docs/server-primitives/source), and [Workspace context](/docs/agents/workspace-context) for the APIs.
