import type { IFileSystem } from "just-bash"

export type ShellContent = string | Uint8Array

export interface ShellReadFileOptions {
  encoding?: "utf8" | "binary"
}

export interface ShellListOptions {
  recursive?: boolean
}

export interface ShellMkdirOptions {
  recursive?: boolean
}

export interface ShellRmOptions {
  force?: boolean
  recursive?: boolean
}

export interface ShellEntry {
  path: string
  type: "file" | "directory"
  size?: number
}

export interface ShellStat extends ShellEntry {}

export interface ShellSearchQuery {
  pattern: string
  cwd?: string
  paths?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}

export interface ShellSearchHit {
  path: string
  line: number
  column: number
  text: string
}

export interface ReadonlyShellWorkspace {
  readFile(path: string, options?: ShellReadFileOptions): Promise<string | Uint8Array>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<ShellStat>
  list(path?: string, options?: ShellListOptions): Promise<ShellEntry[]>
}

export interface SearchableShellWorkspace extends ReadonlyShellWorkspace {
  search(query: ShellSearchQuery): Promise<ShellSearchHit[]>
}

export interface WritableShellWorkspace extends ReadonlyShellWorkspace {
  writeFile(path: string, content: ShellContent): Promise<void>
  mkdir(path: string, options?: ShellMkdirOptions): Promise<void>
  rm(path: string, options?: ShellRmOptions): Promise<void>
}

export interface ShellRuntimeExecOptions {
  cwd?: string
  env?: Record<string, string>
  onStderr?: (data: string) => void
  onStdout?: (data: string) => void
  timeout?: number
}

export interface ShellRuntimeExecResult {
  exitCode: number | null
  stderr: string
  stdout: string
}

export interface ShellRuntime {
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellRuntimeExecResult>
  supports: {
    cwd: boolean
    env: boolean
    streaming: boolean
    writeFs: boolean
  }
}

export interface CloudflareShellClient {
  exec: (
    command: string,
    args?: string[],
    options?: {
      cwd?: string
      env?: Record<string, string>
      onStderr?: (data: string) => void
      onStdout?: (data: string) => void
      timeout?: number
    },
  ) => Promise<{
    code: number | null
    stderr: string
    stdout: string
  }>
  supports: {
    execCwd: boolean
    execEnv: boolean
  }
}

export interface WorkspaceShellFileSystem extends IFileSystem {
  readonly writeFs: boolean
}

export interface JustBashRuntimeOptions {
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
}

export interface CloudflareShellRuntimeOptions {
  sandbox: CloudflareShellClient
}

export interface ShellRuntimePolicy {
  allowedCommands?: string[]
  cwd?: string
  singleCommand?: boolean
}

export type CreateShellRuntimeOptions =
  | ({ provider: "just-bash" } & JustBashRuntimeOptions & ShellRuntimePolicy)
  | ({ provider: "cloudflare-shell" } & CloudflareShellRuntimeOptions & ShellRuntimePolicy)
