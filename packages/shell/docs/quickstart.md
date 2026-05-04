---
title: Shell quickstart
description: Create a read-only workspace shell runtime and run safe inspection commands.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates a shell runtime that can inspect workspace files but cannot mutate them.

::steps

### Install Shell

```bash
pnpm add @vitehub/shell
```

### Provide a workspace API

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
    return {
      path,
      size: files[path]?.length,
      type: 'file' as const,
    }
  },
  async list() {
    return Object.keys(files).map((path) => ({
      path,
      size: files[path].length,
      type: 'file' as const,
    }))
  },
}
```

Real apps usually pass a ViteHub workspace facade instead of this minimal object.

### Create the runtime

```ts
import {
  createReadonlyWorkspaceFs,
  createShellRuntime,
  workspaceMountPoint,
} from '@vitehub/shell'

const runtime = createShellRuntime({
  allowedCommands: ['pwd', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'rg'],
  commands: ['pwd', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'rg'],
  cwd: workspaceMountPoint,
  fs: createReadonlyWorkspaceFs(workspace),
  provider: 'just-bash',
  singleCommand: true,
})
```

### Run an inspection command

```ts
const result = await runtime.exec('cat README.md')

console.log(result.exitCode)
console.log(result.stdout)
console.error(result.stderr)
```

Expected result shape:

```json
{
  "exitCode": 0,
  "stderr": "",
  "stdout": "# Docs\n"
}
```

::

## Next steps

- Use [Usage](./usage) to add search helpers or writable filesystem access.
- Use [Runtime API](./runtime-api) for exact provider option shapes.
- Use [Troubleshooting](./troubleshooting) if a command is rejected by policy.
