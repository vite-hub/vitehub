export interface VercelSandboxRunCommandParams {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sudo?: boolean
  detached?: boolean
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  signal?: AbortSignal
}

export interface VercelSandboxInstance {
  fs?: {
    readFile: {
      (path: string, options?: { encoding?: null, signal?: AbortSignal } | null): Promise<Uint8Array>
      (path: string, options: { encoding: BufferEncoding, signal?: AbortSignal } | BufferEncoding): Promise<string>
    }
    writeFile: (path: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding, signal?: AbortSignal } | BufferEncoding) => Promise<void>
    mkdir: (path: string, options?: { recursive?: boolean, signal?: AbortSignal } | number) => Promise<string | undefined>
    readdir: (path: string, options?: { signal?: AbortSignal, withFileTypes?: false }) => Promise<string[]>
    stat: (path: string, options?: { signal?: AbortSignal }) => Promise<{ isFile(): boolean, isDirectory(): boolean, isSymbolicLink(): boolean, size: number, mtime?: Date, mtimeMs?: number }>
    rm: (path: string, options?: { recursive?: boolean, force?: boolean, signal?: AbortSignal }) => Promise<void>
    rename: (oldPath: string, newPath: string, options?: { signal?: AbortSignal }) => Promise<void>
    exists?: (path: string, options?: { signal?: AbortSignal }) => Promise<boolean>
    access?: (path: string, options?: { signal?: AbortSignal }) => Promise<void>
  }
  runCommand: {
    (cmd: string, args?: string[], opts?: { signal?: AbortSignal }): Promise<VercelSandboxCommandResult>
    (params: VercelSandboxRunCommandParams & { detached: true }): Promise<VercelSandboxCommandResult>
    (params: VercelSandboxRunCommandParams): Promise<VercelSandboxCommandResult>
  }
  writeFiles: (files: Array<{ path: string, content: ArrayBufferView<ArrayBufferLike> }>, opts?: { signal?: AbortSignal }) => Promise<void>
  readFileToBuffer: (opts: { path: string, cwd?: string }, opts2?: { signal?: AbortSignal }) => Promise<Uint8Array | null>
  readFile: (opts: { path: string, cwd?: string }, opts2?: { signal?: AbortSignal }) => Promise<NodeJS.ReadableStream | null>
  mkDir: (path: string, opts?: { signal?: AbortSignal }) => Promise<void>
  domain: (port: number) => string
  stop?: (opts?: { signal?: AbortSignal, blocking?: boolean }) => Promise<unknown>
  [Symbol.asyncDispose]?: () => Promise<void>
}

export interface VercelSandboxCommandResult {
  exitCode: number
  stdout: () => Promise<string>
  stderr: () => Promise<string>
  logs: () => AsyncGenerator<{ stream: 'stdout' | 'stderr', data: string }>
  kill: () => Promise<void>
  wait: () => Promise<{ exitCode: number }>
}

export interface VercelSandboxSDK {
  Sandbox: {
    create: (options: VercelSandboxCreateOptions) => Promise<VercelSandboxInstance>
    list: () => Promise<{ sandboxes: VercelSandboxListItem[], pagination?: { count: number, next: number | null, prev: number | null } }>
    get: (params: { sandboxId: string, token?: string, teamId?: string, projectId?: string } | string) => Promise<VercelSandboxInstance | null>
  }
}

export type VercelSandboxSource
  = { type: 'git', url: string, depth?: number, revision?: string }
    | { type: 'git', url: string, username: string, password: string, depth?: number, revision?: string }
    | { type: 'tarball', url: string }
    | { type: 'snapshot', snapshotId: string }

export interface VercelSandboxCreateOptions {
  runtime: string
  timeout?: number
  resources?: { vcpus?: number }
  ports?: number[]
  source?: VercelSandboxSource
  networkPolicy?: SandboxNetworkPolicy
  token?: string
  teamId?: string
  projectId?: string
}

export interface VercelSandboxListItem {
  id: string
  status: string
  createdAt: string | number
}

export interface VercelSandboxSnapshot {
  id: string
  sandboxId: string
  createdAt: string
}

export type SandboxNetworkPolicy = 'allow-all' | 'deny-all' | {
  allow?: string[] | Record<string, Array<{ transform?: Array<{ headers?: Record<string, string> }> }>>
  subnets?: {
    allow?: string[]
    deny?: string[]
  }
}

export interface VercelSandboxMetadata {
  id: string
  runtime: string
  status: string
  createdAt: string
}

export interface VercelSandboxNamespace {
  readonly native: VercelSandboxInstance
  snapshot: () => Promise<VercelSandboxSnapshot>
  getSnapshot: (id: string) => Promise<VercelSandboxSnapshot>
  listSnapshots: () => Promise<{ snapshots: VercelSandboxSnapshot[] }>
  deleteSnapshot: (id: string) => Promise<void>
  domain: (port: number) => string
  extendTimeout: (durationMs: number) => Promise<void>
  updateNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>
  getMetadata: () => VercelSandboxMetadata
}
