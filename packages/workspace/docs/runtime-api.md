---
title: Runtime API
description: Workspace runtime methods and mount semantics.
navigation.title: Runtime API
navigation.order: 2
frameworks: [vite, nitro]
---

Most application code imports from `@vitehub/workspace`:

```ts
import { defineWorkspace, useWorkspace } from '@vitehub/workspace'
```

The workspace handle is file-tree oriented:

```ts
const workspace = useWorkspace('docs', { allowWrite: true })

await workspace.fs.writeFile('generated/context.md', 'Context')

const entry = await workspace.fs.stat('generated/context.md')
const files = await workspace.fs.glob('**/*.md')
const hits = await workspace.fs.search({ pattern: 'Context', paths: ['generated'] })
```

## Mounts

Use `.tools()` when an AI runtime needs workspace files:

```ts
const readOnlyTools = useWorkspace('docs').tools()
const writableTools = useWorkspace('docs', { allowWrite: true }).tools()
```

Source mounts are resolved behind the workspace API. Agents do not access a real mounted filesystem directly; they only interact with these workspace handles and tools.
