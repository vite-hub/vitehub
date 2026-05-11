---
title: Shell runtime API
description: Reference for Shell exports, providers, filesystems, analysis, and result shapes.
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
  analyzeShellCommand,
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
  | ({ provider: 'just-bash' } & JustBashRuntimeOptions)
  | ({ provider: 'cloudflare-shell' } & CloudflareShellRuntimeOptions)
```

## Runtime

```ts
interface ShellRuntime {
  analyze?: (command: string, options?: ShellAnalyzeOptions) => Promise<ShellAnalyzeResult>
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

## Analysis

```ts
interface ShellAnalyzeResult {
  ok: boolean
  parser: 'sh-syntax'
  commands?: string[]
  hasPipelines?: boolean
  hasRedirects?: boolean
  hasHeredocs?: boolean
  hasCommandSubstitution?: boolean
  error?: string
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
    commands?: string[]
    cwd?: string
    fs: WorkspaceShellFileSystem
    maxOutputLength?: number
  }
): Promise<ShellRuntimeExecResult>
```
