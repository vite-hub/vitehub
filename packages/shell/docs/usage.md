---
title: Shell usage
description: Configure command policies, workspace filesystems, search commands, and Cloudflare shell clients.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart) when you need to tune policy or connect a different execution backend.

## Restrict commands

Pass the commands supported by the filesystem adapter and the commands allowed by policy.

```ts
const runtime = createShellRuntime({
  allowedCommands: ['pwd', 'ls', 'cat', 'rg'],
  commands: ['pwd', 'ls', 'cat', 'rg'],
  cwd: workspaceMountPoint,
  fs,
  provider: 'just-bash',
  singleCommand: true,
})
```

Use `singleCommand: true` for agent-facing command execution. It rejects separators such as `&&`, `;`, pipes, redirects, command substitution, and multiline commands.

## Use a read-only workspace filesystem

```ts
import { createReadonlyWorkspaceFs } from '@vitehub/shell'

const fs = createReadonlyWorkspaceFs(workspace)
```

Read-only filesystems support inspection commands. Write attempts fail with a read-only filesystem error or command policy rejection.

## Use a writable workspace filesystem

```ts
import { createWritableWorkspaceFs } from '@vitehub/shell'

const fs = createWritableWorkspaceFs(workspace)
```

Writable filesystems support filesystem mutation APIs when the underlying workspace implements `writeFile`, `mkdir`, and `rm`.

Keep command policy explicit even with writable filesystems. Enable only the commands a caller needs.

## Run workspace inspection commands

Use `runWorkspaceInspectionCommand()` when you want search command handling and output limits around a searchable workspace.

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

`rg` and `grep` are routed through the workspace `search()` API. Other commands run through the `just-bash` runtime.

## Clean workspace paths

Use the path helpers before mutating workspace state from user input.

```ts
import {
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
} from '@vitehub/shell'

const readPath = cleanWorkspaceShellPath('/workspace/docs/README.md')
const writePath = cleanWorkspaceMutationPath('generated/summary.md')
```

`cleanWorkspaceMutationPath()` rejects the workspace root because root-level mutation is too broad.

## Use a Cloudflare shell client

Use `cloudflare-shell` when execution happens in a Cloudflare sandbox-compatible client.

```ts
const runtime = createShellRuntime({
  provider: 'cloudflare-shell',
  sandbox,
})

const result = await runtime.exec('node --version', {
  timeout: 5_000,
})
```

The client must expose `exec(command, args, options)` and support metadata. Shell parses the command string into command and args before delegating.

## Stream output

Both runtime providers accept `onStdout` and `onStderr` callbacks when the underlying backend supports streaming.

```ts
await runtime.exec('cat README.md', {
  onStdout(chunk) {
    console.log(chunk)
  },
})
```
