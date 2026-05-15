---
title: Shell usage
description: Configure real shell execution, workspace filesystems, analysis, and sandbox clients.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Choose workspace commands

Pass the commands that `just-bash` should expose in the workspace-backed runtime.

```ts
const runtime = createShellRuntime({
  commands: ['pwd', 'ls', 'cat', 'head', 'rg'],
  fs,
  provider: 'just-bash',
})
```

The runtime accepts real shell syntax. Pipes, redirects, chaining, command substitution, and multiline commands are passed through to the provider.

## Use read-only files

```ts
import { createReadonlyWorkspaceFs } from '@vitehub/shell'

const fs = createReadonlyWorkspaceFs(workspace)
```

Use read-only filesystems for inspection surfaces.

## Use writable files

```ts
import { createWritableWorkspaceFs } from '@vitehub/shell'

const fs = createWritableWorkspaceFs(workspace)
```

Writable filesystems require the workspace to implement `writeFile`, `mkdir`, and `rm`. Keep the exposed command list narrow.

## Analyze commands

Use `analyzeShellCommand()` when you need advisory metadata before execution.

```ts
import { analyzeShellCommand } from '@vitehub/shell'

const analysis = await analyzeShellCommand('rg TODO docs | head -n 20')
```

## Run workspace shell commands

Use `runWorkspaceInspectionCommand()` when AI tools should execute against a ViteHub workspace filesystem.

```ts
import {
  createReadonlyWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from '@vitehub/shell'

const result = await runWorkspaceInspectionCommand(workspace, 'rg TODO docs | head -n 20', {
  commands: ['rg', 'head'],
  cwd: workspaceMountPoint,
  fs: createReadonlyWorkspaceFs(workspace),
  maxOutputLength: 30_000,
})
```

## Clean paths

Use path helpers before reading or mutating workspace paths from input.

```ts
import {
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
} from '@vitehub/shell'

const readPath = cleanWorkspaceShellPath('/workspace/docs/README.md')
const writePath = cleanWorkspaceMutationPath('generated/summary.md')
```

`cleanWorkspaceMutationPath()` rejects the workspace root.

## Use a Cloudflare shell client

Use `cloudflare-shell` when a Cloudflare sandbox-compatible client owns execution.

```ts
const runtime = createShellRuntime({
  provider: 'cloudflare-shell',
  sandbox,
})

const result = await runtime.exec('node --version', {
  timeout: 5_000,
})
```

The client must expose `exec(command, options)` and support metadata.
