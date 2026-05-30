---
title: Runtime API
description: Workspace runtime methods and mount semantics.
navigation.title: Runtime API
navigation.order: 2
frameworks: [vite, nitro]
---

Most application code imports from `@vite-hub/workspace`:

```ts
import { defineWorkspace, useWorkspace } from '@vite-hub/workspace'
```

## Integration API

Vite config imports the plugin from `@vite-hub/workspace/vite`:

```ts
import { hubWorkspace } from '@vite-hub/workspace/vite'
```

`hubWorkspace(options?)` accepts the same integration options as `vite.config.workspace`. When both are present, `vite.config.workspace` takes precedence.

The workspace handle is file-tree oriented:

```ts
const workspace = useWorkspace('docs', { mode: "write" })

await workspace.fs.writeFile('generated/context.md', 'Context')

const entry = await workspace.fs.stat('generated/context.md')
const files = await workspace.fs.glob('**/*.md')
const hits = await workspace.fs.search({ pattern: 'Context', paths: ['generated'] })
```

## Sessions

`workspace.startSession()` derives runtime behavior from the workspace definition and app-level config. It does not accept provider selection options:

```ts
const workspace = useWorkspace('docs', { mode: "write" })
const session = await workspace.startSession()

await session.exec('pnpm', ['test'])
await session.commit({ message: 'Persist sandbox changes' })
await session.close()
```

All sessions expose the same methods:

| Method | Behavior |
| --- | --- |
| `readFile(path, options?)` | Read from the active session filesystem. |
| `writeFile(path, content, options?)` | Write to the active session filesystem. |
| `list(path?, options?)` | List session files. |
| `glob(pattern, options?)` | Match session files. |
| `search(query)` | Search text files in the session. |
| `diff()` | Compare session changes against canonical workspace state. |
| `commit(options?)` | Persist session changes back to the workspace store. |
| `exec(command, args?, options?)` | Execute in the configured runtime. Throws when the workspace has no executable runtime. |
| `close()` | Release session-level resources. |

Use `runtime: 'sandbox'` in the workspace definition when `exec()` should run inside the configured app sandbox provider:

```ts
export default defineWorkspace({
  store: { provider: 'memory' },
  runtime: 'sandbox',
  sources: {
    // ...
  },
})
```

Sandbox sessions materialize at runtime because provider bindings, sandbox IDs, sessions, and lazy sources are request/runtime concerns. Build-time materialization remains limited to source sync and static asset registries.

## Mounts

Use explicit tool presets when an AI runtime needs workspace files:

```ts
const readOnlyTools = useWorkspace('docs').tools.inspect()
const noTools = useWorkspace('docs').tools.none()
const writableTools = useWorkspace('docs', { mode: "write" }).tools.write()
```

`inspect()` exposes the restricted read-only `shell` inspection tool. `none()` returns no tools. `write()` requires a writable facade and exposes structured mutation tools intentionally.

Source mounts are resolved behind the workspace API. Agents do not access a real mounted filesystem directly; they only interact with these workspace handles and tools.
