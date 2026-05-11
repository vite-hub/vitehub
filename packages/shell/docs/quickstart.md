---
title: Shell quickstart
description: Create a read-only workspace shell runtime and run one command.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates a shell runtime that can inspect workspace files.

::steps

### Install Shell

```bash
pnpm add @vitehub/shell
```

### Provide a workspace

Shell expects a workspace object with read methods.

```ts
const workspace = {
  async readFile(path: string) {
    return files[path]
  },
  async exists(path: string) {
    return path in files
  },
  async stat(path: string) {
    return { path, type: 'file' as const, size: files[path]?.length || 0 }
  },
  async list() {
    return Object.entries(files).map(([path, contents]) => ({
      path,
      type: 'file' as const,
      size: contents.length,
    }))
  },
}
```

### Create the runtime

```ts
import {
  createReadonlyWorkspaceFs,
  createShellRuntime,
  workspaceMountPoint,
} from '@vitehub/shell'

const runtime = createShellRuntime({
  commands: ['pwd', 'ls', 'cat', 'rg'],
  cwd: workspaceMountPoint,
  fs: createReadonlyWorkspaceFs(workspace),
  provider: 'just-bash',
})
```

### Run a command

```ts
const result = await runtime.exec('cat README.md | head -n 20')

console.log(result.exitCode)
console.log(result.stdout)
console.error(result.stderr)
```

::

## Verify

A successful command returns `exitCode: 0` and writes command output to `stdout`.
