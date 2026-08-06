---
title: Workspace and Sources
description: Understand how persistent files differ from read-only origins.
navigation.group: Core vocabulary
navigation.order: 13
icon: i-lucide-folder-git-2
---

A Workspace is a named persistent file tree. A Source is a named origin that exposes read-only files, items, or controlled requests. A mount places a Source inside the Workspace; it does not turn the Source into the tree.

The Workspace owns file operations and persistence. The Source owns where the material comes from.

## Define the tree and its origins

```ts [server/workspaces/docs.ts]
import { defineWorkspace, file, glob } from '@vite-hub/workspace'

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

The Workspace owns the rules and tree. The Sources provide the material that the tree exposes.

## Agent access is another choice

Workspace context does not automatically give an Agent unrestricted file tools. Attach a Capability such as `workspaceShell()` when the Agent should read or mutate Workspace files.

Workspace Scope narrows the visible tree for one invocation. The trusted host or invocation context selects that scope; the model does not.

## Inspect the result

Use `useWorkspace()` from server code to inspect the runtime tree. Generated Workspace and Source metadata shows discovered names and request descriptors without exposing provider credentials.

Read [Workspace](/docs/server-primitives/workspace), [Source](/docs/server-primitives/source), and [Workspace context](/docs/agents/workspace-context) for the APIs.
