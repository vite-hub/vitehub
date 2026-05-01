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
const workspace = await useWorkspace('docs')

await workspace.sync()
await workspace.writeFile('generated/context.md', 'Context')

const entry = await workspace.stat('generated/context.md')
const files = await workspace.glob('**/*.md')
const snapshot = await workspace.snapshot()
const diff = await workspace.diff({ from: snapshot })
```

`sync()` is explicit. `useWorkspace()` opens the registered workspace and does not load remote sources by itself.

## Mounts

Use `mount()` when a runtime or sandbox needs workspace files:

```ts
const mount = workspace.mount({
  mode: 'read-only',
  target: '/workspace',
})
```

Mount mode semantics:

| Mode | Meaning |
| --- | --- |
| `read-only` | Runtime can inspect files but cannot mutate canonical workspace state. |
| `read-write` | Runtime writes are intended to become canonical state through an explicit commit path. |
| `copy-on-write` | Runtime receives an isolated branch or snapshot that can be diffed and exported. |
