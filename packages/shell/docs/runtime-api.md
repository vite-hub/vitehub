---
title: Shell runtime API
description: Reference for Shell exports, providers, filesystems, analysis, and observation shapes.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page for exact exported names.

## Imports

```ts
import {
  analyzeShellCommand,
  createShellRuntime,
  type ShellObservation,
  type ShellRuntime,
  type ShellSession,
  type ShellSessionPolicy,
} from '@vitehub/shell'
import { createCloudflareShellProvider } from '@vitehub/shell/providers/cloudflare'
import { createJustBashProvider } from '@vitehub/shell/providers/just-bash'
import {
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from '@vitehub/shell/workspace'
```

## Create a runtime

```ts
const runtime = createShellRuntime({
  policy: {
    maxOutputLength: 30_000,
    maxShellCalls: 8,
    timeout: 10_000,
  },
  provider: createJustBashProvider({
    commands: ['pwd', 'ls', 'cat', 'rg'],
    cwd: workspaceMountPoint,
    fs: createReadonlyWorkspaceFs(workspace),
  }),
})
```

## Runtime and session

```ts
interface ShellRuntime {
  boundary: ShellBoundary
  createSession(options?: CreateShellSessionOptions): ShellSession
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
}

interface ShellSession {
  boundary: ShellBoundary
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
  startProcess(command: string, options?: ShellRuntimeExecOptions): Promise<ShellProcess>
  listProcesses(): Promise<ShellProcess[]>
  dispose(): Promise<ShellObservation>
}
```

`runtime.exec()` is convenience sugar over a short-lived session.

## Observation

```ts
interface ShellObservation {
  event: ShellObservationEvent
  command?: string
  cwd?: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs?: number
  timedOut?: boolean
  maxOutputLength?: number
  outputTruncated?: boolean
}
```

## Providers

```ts
const justBash = createJustBashProvider({
  commands: ['pwd', 'ls', 'cat', 'rg'],
  cwd: workspaceMountPoint,
  fs,
})

const cloudflare = createCloudflareShellProvider({ sandbox })
```

## Workspace helpers

```ts
function createReadonlyWorkspaceFs(workspace: ReadonlyShellWorkspace): WorkspaceShellFileSystem
function createWritableWorkspaceFs(workspace: WritableShellWorkspace): WorkspaceShellFileSystem

function runWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
  command: string,
  options: {
    broadSearchPaths?: string[]
    commands?: string[]
    cwd?: string
    fs: WorkspaceShellFileSystem
    maxOutputLength?: number
    timeout?: number
  }
): Promise<ShellObservation>
```
