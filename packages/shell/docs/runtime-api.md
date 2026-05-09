---
title: Shell runtime API
description: Reference for Shell exports, providers, filesystems, policy, and result shapes.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page for exact exported names.

## Imports

```ts
import {
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
  createCloudflareShellRuntime,
  createReadonlyWorkspaceFs,
  createShellRuntime,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from '@vitehub/shell'
```

## Create a runtime

```ts
function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime
```

```ts
type CreateShellRuntimeOptions =
  | ({ provider: 'just-bash' } & JustBashRuntimeOptions & ShellRuntimePolicy)
  | ({ provider: 'cloudflare-shell' } & CloudflareShellRuntimeOptions & ShellRuntimePolicy)
```

## Runtime

```ts
interface ShellRuntime {
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellRuntimeExecResult>
  supports: {
    cwd: boolean
    env: boolean
    streaming: boolean
    writeFs: boolean
  }
}
```

```ts
interface ShellRuntimeExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
}
```

## Policy

```ts
interface ShellRuntimePolicy {
  allowedCommands?: string[]
  singleCommand?: boolean
}
```

## Just Bash options

```ts
interface JustBashRuntimeOptions {
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
}
```

## Cloudflare options

```ts
interface CloudflareShellRuntimeOptions {
  sandbox: CloudflareShellClient
}
```

## Filesystem adapters

```ts
function createReadonlyWorkspaceFs(workspace: ReadonlyShellWorkspace): WorkspaceShellFileSystem
function createWritableWorkspaceFs(workspace: WritableShellWorkspace): WorkspaceShellFileSystem
```

## Path helpers

```ts
const workspaceMountPoint = '/workspace'

function cleanWorkspaceShellPath(path?: string): string
function cleanWorkspaceMutationPath(path: string): string
```

## Inspection helper

```ts
function runWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
  command: string,
  options: {
    commands: string[]
    cwd?: string
    fs: WorkspaceShellFileSystem
    maxOutputLength?: number
  }
): Promise<ShellRuntimeExecResult>
```
