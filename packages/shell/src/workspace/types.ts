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
