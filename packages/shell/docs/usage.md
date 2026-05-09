---
title: Shell usage
description: Configure command policy, workspace filesystems, search, and sandbox clients.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Restrict commands

Pass both the supported command list and the policy allowlist.

```ts
const runtime = createShellRuntime({
  allowedCommands: ['pwd', 'ls', 'cat', 'rg'],
  commands: ['pwd', 'ls', 'cat', 'rg'],
  fs,
  provider: 'just-bash',
  singleCommand: true,
})
```

`singleCommand: true` rejects separators, pipes, redirects, command substitution, and multiline commands.

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

Writable filesystems require the workspace to implement `writeFile`, `mkdir`, and `rm`. Keep the command allowlist narrow.

## Run search commands

Use `runWorkspaceInspectionCommand()` when `rg` or `grep` should run through the workspace search API.

```ts
import {
  createReadonlyWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from '@vitehub/shell'

const result = await runWorkspaceInspectionCommand(workspace, 'rg TODO docs', {
  commands: ['rg'],
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

The client must expose `exec(command, args, options)` and support metadata.
