---
title: Runtime API
description: Workspace runtime methods and AI SDK tools.
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

## Tools

Use `.tools()` when an AI runtime needs structured write access to workspace files:

```ts
const writableTools = await useWorkspace('docs', { allowWrite: true }).tools()
```

Sources are resolved behind the workspace API. Agents do not access a real mounted filesystem directly; they interact with workspace handles and tools.
