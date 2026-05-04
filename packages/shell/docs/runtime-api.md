---
title: Shell runtime API
description: Reference for Shell exports, runtime providers, filesystem adapters, path helpers, and result shapes.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact option and result shapes. For a guided setup, start with [Quickstart](./quickstart).

## Imports

```ts
import {
  createCloudflareShellRuntime,
  createReadonlyWorkspaceFs,
  createShellRuntime,
  createWritableWorkspaceFs,
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from '@vitehub/shell'
```

## `createShellRuntime()`

```ts
function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime
```

```ts
type CreateShellRuntimeOptions =
  | ({ provider: 'just-bash' } & JustBashRuntimeOptions & ShellRuntimePolicy)
  | ({ provider: 'cloudflare-shell' } & CloudflareShellRuntimeOptions & ShellRuntimePolicy)
```

## `ShellRuntime`

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

### `ShellRuntimeExecOptions`

```ts
interface ShellRuntimeExecOptions {
  cwd?: string
  env?: Record<string, string>
  onStderr?: (data: string) => void
  onStdout?: (data: string) => void
  timeout?: number
}
```

### `ShellRuntimeExecResult`

```ts
interface ShellRuntimeExecResult {
  exitCode: number | null
  stderr: string
  stdout: string
}
```

## Just Bash provider

```ts
interface JustBashRuntimeOptions {
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
}
```

Use `createReadonlyWorkspaceFs()` or `createWritableWorkspaceFs()` to build the filesystem adapter.

## Cloudflare provider

```ts
interface CloudflareShellRuntimeOptions {
  sandbox: CloudflareShellClient
}
```

```ts
interface CloudflareShellClient {
  exec(command: string, args?: string[], options?: {
    cwd?: string
    env?: Record<string, string>
    onStderr?: (data: string) => void
    onStdout?: (data: string) => void
    timeout?: number
  }): Promise<{
    code: number | null
    stderr: string
    stdout: string
  }>
  supports: {
    execCwd: boolean
    execEnv: boolean
  }
}
```

## Policy

```ts
interface ShellRuntimePolicy {
  allowedCommands?: string[]
  cwd?: string
  singleCommand?: boolean
}
```

`allowedCommands` rejects commands outside the allowlist. `singleCommand` rejects shell syntax that combines commands or redirects output.

## Workspace filesystems

```ts
function createReadonlyWorkspaceFs(workspace: ReadonlyShellWorkspace): WorkspaceShellFileSystem
function createWritableWorkspaceFs(workspace: WritableShellWorkspace): WorkspaceShellFileSystem
```

```ts
interface ReadonlyShellWorkspace {
  readFile(path: string, options?: ShellReadFileOptions): Promise<string | Uint8Array>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<ShellStat>
  list(path?: string, options?: ShellListOptions): Promise<ShellEntry[]>
}

interface SearchableShellWorkspace extends ReadonlyShellWorkspace {
  search(query: ShellSearchQuery): Promise<ShellSearchHit[]>
}

interface WritableShellWorkspace extends ReadonlyShellWorkspace {
  writeFile(path: string, content: ShellContent): Promise<void>
  mkdir(path: string, options?: ShellMkdirOptions): Promise<void>
  rm(path: string, options?: ShellRmOptions): Promise<void>
}
```

## Path helpers

```ts
const workspaceMountPoint = '/workspace'

function cleanWorkspaceShellPath(path?: string): string
function cleanWorkspaceMutationPath(path: string): string
```

`cleanWorkspaceShellPath()` returns a workspace-relative path. `cleanWorkspaceMutationPath()` also rejects the workspace root.

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

Use this helper for command surfaces that need `rg` and `grep` to run through the workspace search API.
