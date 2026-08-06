---
title: Workspace and Sources
description: Understand the persistent file tree and the read-only origins that appear inside it.
navigation.group: Core vocabulary
navigation.order: 13
icon: i-lucide-folder-git-2
---

A Workspace is a named persistent file tree. A Source is a named origin that exposes read-only files, items, or controlled requests. A mount places a Source inside the Workspace tree; it does not turn the Source into the tree.

Workspace owns file operations and persistence. Source owns where material comes from.

## Define the two boundaries

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

## Agent access is another boundary

An Agent with Workspace context does not automatically receive unrestricted file tools. Attach a Capability such as `workspaceShell()` when the Agent Driver should read or mutate Workspace files.

Workspace Scope narrows the visible tree for one Agent Invocation. Trusted host or invocation context selects the scope; the model does not select it.

## Inspect the result

Use `useWorkspace()` from server code to inspect the runtime tree. Generated Workspace and Source metadata under `.vitehub` shows the discovered names and request descriptors without exposing provider credentials.

Read [Workspace](/docs/server-primitives/workspace), [Source](/docs/server-primitives/source), and [Workspace context](/docs/agents/workspace-context) for the API surfaces.
