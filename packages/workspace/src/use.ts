import { posix } from "node:path"

import type { Tool, ToolSet } from "ai"

import { createWorkspaceTools, type WorkspaceMoveResult, type WorkspacePathResult, type WorkspaceShellResult } from "./ai.ts"
import { useWorkspaceAssets } from "./asset-registry.ts"
import { WorkspaceError } from "./errors.ts"
import { normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern } from "./path.ts"
import { useRegisteredWorkspace } from "./registry.ts"

import type {
  GlobOptions,
  ListOptions,
  MkdirOptions,
  ReadFileOptions,
  ReadFileResult,
  RmOptions,
  Workspace,
  WorkspaceAssetPath,
  WorkspaceAssets,
  WorkspaceContent,
  WorkspaceEntry,
  WorkspaceName,
  WorkspaceStat,
  WriteFileOptions,
} from "./types.ts"

type WorkspaceWritablePath<Name extends WorkspaceName> = WorkspaceAssetPath<Name> | (string & {})

export interface UseWorkspaceOptions {
  allowWrite?: boolean
}

export interface WorkspaceToolOptions {
  cwd?: string
  list?: boolean
  maxOutputLength?: number
  read?: boolean
  search?: boolean
}

export interface WritableWorkspaceToolOptions extends WorkspaceToolOptions {
  appendFile?: boolean
  copyPath?: boolean
  deletePath?: boolean
  makeDir?: boolean
  movePath?: boolean
  writeFile?: boolean
}

type EnabledReadCapability<Options, Key extends keyof WorkspaceToolOptions> = Options extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

type FacadeShellEnabled<Options> = true extends
  | EnabledReadCapability<Options, "list">
  | EnabledReadCapability<Options, "read">
  | EnabledReadCapability<Options, "search">
  ? true
  : false

type WorkspaceWriteToolMap = {
  appendFile: Tool<{ content: string, path: string }, WorkspacePathResult>
  copyPath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  deletePath: Tool<{ force?: boolean, path: string, recursive?: boolean }, WorkspacePathResult>
  makeDir: Tool<{ path: string, recursive?: boolean }, WorkspacePathResult>
  movePath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  writeFile: Tool<{ content: string, mediaType?: string, path: string }, WorkspacePathResult>
}

type EnabledWriteCapability<Options, Key extends keyof WorkspaceWriteToolMap> = Options extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

export type WorkspaceReadTools<Options = undefined> = ((FacadeShellEnabled<Options> extends true
  ? { shell: Tool<{ command: string }, WorkspaceShellResult> }
  : {}) & ToolSet)

export type WorkspaceWriteTools<Options = undefined> = (WorkspaceReadTools<Options> & {
  [Key in keyof WorkspaceWriteToolMap as EnabledWriteCapability<Options, Key> extends true ? Key : never]: WorkspaceWriteToolMap[Key]
}) & ToolSet

export type ReadonlyWorkspaceFs<Name extends WorkspaceName = WorkspaceName> = WorkspaceAssets<WorkspaceAssetPath<Name>>

export interface WritableWorkspaceFs<Name extends WorkspaceName = WorkspaceName> {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: WorkspaceWritablePath<Name>, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: WorkspaceWritablePath<Name>, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
  appendFile(path: WorkspaceWritablePath<Name>, content: string): Promise<void>
  stat(path: WorkspaceWritablePath<Name>): Promise<WorkspaceStat>
  exists(path: WorkspaceWritablePath<Name>): Promise<boolean>
  list(path?: WorkspaceWritablePath<Name> | "", options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: WorkspaceWritablePath<Name> | Array<WorkspaceWritablePath<Name>>, options?: GlobOptions): Promise<WorkspaceEntry[]>
  mkdir(path: WorkspaceWritablePath<Name>, options?: MkdirOptions): Promise<void>
  rm(path: WorkspaceWritablePath<Name>, options?: RmOptions): Promise<void>
  movePath(from: WorkspaceWritablePath<Name>, to: WorkspaceWritablePath<Name>, options?: { overwrite?: boolean }): Promise<void>
  copyPath(from: WorkspaceWritablePath<Name>, to: WorkspaceWritablePath<Name>, options?: { overwrite?: boolean }): Promise<void>
}

export interface ReadonlyWorkspaceFacade<Name extends WorkspaceName = WorkspaceName> {
  fs: ReadonlyWorkspaceFs<Name>
  tools<Options extends WorkspaceToolOptions | undefined = undefined>(options?: Options): WorkspaceReadTools<Options>
}

export interface WritableWorkspaceFacade<Name extends WorkspaceName = WorkspaceName> {
  fs: WritableWorkspaceFs<Name>
  tools<Options extends WritableWorkspaceToolOptions | undefined = undefined>(options?: Options): WorkspaceWriteTools<Options>
}

export type WorkspaceFacade<Name extends WorkspaceName = WorkspaceName, AllowWrite extends boolean = false> =
  AllowWrite extends true ? WritableWorkspaceFacade<Name> : ReadonlyWorkspaceFacade<Name>

function normalizePath(path: string, allowEmpty = false) {
  return normalizeSafeWorkspacePath(path, { allowEmpty })
}

function normalizeListPath(path = "") {
  return normalizePath(path, true)
}

function normalizePattern(pattern: string | string[]) {
  return Array.isArray(pattern) ? pattern.map(normalizeSafeWorkspacePattern) : normalizeSafeWorkspacePattern(pattern)
}

function createLazyWorkspace(name: WorkspaceName): Workspace {
  let workspacePromise: Promise<Workspace> | undefined
  let syncPromise: Promise<void> | undefined

  async function resolveWorkspace() {
    workspacePromise ||= useRegisteredWorkspace(name)
    return await workspacePromise
  }

  async function resolveSyncedWorkspace() {
    const workspace = await resolveWorkspace()
    syncPromise ||= workspace.sync()
    await syncPromise
    return workspace
  }

  const workspace = {
    name,
    async sync(options) {
      const resolved = await resolveWorkspace()
      const next = resolved.sync(options)
      syncPromise = next
      await next
    },
    async readFile(path, options) {
      return await (await resolveSyncedWorkspace()).readFile(normalizePath(path), options as never)
    },
    async writeFile(path, content, options) {
      await (await resolveSyncedWorkspace()).writeFile(normalizePath(path), content, options)
    },
    async list(path, options) {
      return await (await resolveSyncedWorkspace()).list(path ? normalizeListPath(path) : "", options)
    },
    async glob(pattern, options) {
      return await (await resolveSyncedWorkspace()).glob(normalizePattern(pattern), options)
    },
    async stat(path) {
      return await (await resolveSyncedWorkspace()).stat(normalizePath(path))
    },
    async exists(path) {
      return await (await resolveSyncedWorkspace()).exists(normalizePath(path))
    },
    async mkdir(path, options) {
      await (await resolveSyncedWorkspace()).mkdir(normalizePath(path), options)
    },
    async rm(path, options) {
      await (await resolveSyncedWorkspace()).rm(normalizePath(path), options)
    },
    async snapshot(options) {
      return await (await resolveSyncedWorkspace()).snapshot(options)
    },
    async diff(options) {
      return await (await resolveSyncedWorkspace()).diff(options)
    },
    async open(options) {
      return await (await resolveSyncedWorkspace()).open(options)
    },
    mount(options) {
      const mode = options?.mode || "read-only"
      return {
        workspace,
        mode,
        target: options?.target || "/workspace",
        async diff() {
          return await (await resolveSyncedWorkspace()).mount(options).diff()
        },
        async commit(commitOptions) {
          await (await resolveSyncedWorkspace()).mount(options).commit(commitOptions)
        },
        async export() {
          return await (await resolveSyncedWorkspace()).mount(options).export()
        },
      }
    },
  } as Workspace

  return workspace
}

async function ensureMissingOrReplaceable(workspace: Workspace, path: string, overwrite = false) {
  if (!await workspace.exists(path)) return
  if (!overwrite) throw new WorkspaceError(`[vitehub] Workspace path already exists: ${path}.`)
  await workspace.rm(path, { recursive: true, force: true })
}

async function copyWorkspacePath(workspace: Workspace, from: string, to: string, overwrite = false) {
  if (from === to) throw new WorkspaceError("[vitehub] Source and destination must be different.")

  const source = await workspace.stat(from)
  if (source.type === "directory" && to.startsWith(`${from}/`)) {
    throw new WorkspaceError("[vitehub] Destination cannot be nested inside the source directory.")
  }

  await ensureMissingOrReplaceable(workspace, to, overwrite)

  if (source.type === "file") {
    const content = await workspace.readFile(from, { encoding: "binary" })
    await workspace.writeFile(to, content, { mediaType: source.mediaType })
    return
  }

  const entries = await workspace.list(from, { recursive: true })
  await workspace.mkdir(to, { recursive: true })

  const directories = entries.filter(entry => entry.type === "directory").sort((left, right) => left.path.length - right.path.length)
  const files = entries.filter(entry => entry.type === "file").sort((left, right) => left.path.localeCompare(right.path))

  for (const entry of directories) {
    const relativePath = entry.path.slice(from.length + 1)
    await workspace.mkdir(posix.join(to, relativePath), { recursive: true })
  }

  for (const entry of files) {
    const relativePath = entry.path.slice(from.length + 1)
    await workspace.writeFile(posix.join(to, relativePath), await workspace.readFile(entry.path, { encoding: "binary" }), { mediaType: entry.mediaType })
  }
}

function createWritableFs<Name extends WorkspaceName>(workspace: Workspace): WritableWorkspaceFs<Name> {
  return {
    readFile: async (path, options) => await workspace.readFile(normalizePath(String(path)), options as never),
    writeFile: async (path, content, options) => await workspace.writeFile(normalizePath(String(path)), content, options),
    appendFile: async (path, content) => {
      const normalized = normalizePath(String(path))
      let current = ""
      try {
        current = String(await workspace.readFile(normalized))
      }
      catch (error) {
        if (!(error instanceof WorkspaceError)) throw error
      }
      await workspace.writeFile(normalized, `${current}${content}`)
    },
    stat: async path => await workspace.stat(normalizePath(String(path))),
    exists: async path => await workspace.exists(normalizePath(String(path))),
    list: async (path, options) => await workspace.list(path ? normalizeListPath(String(path)) : "", options),
    glob: async (pattern, options) => await workspace.glob(normalizePattern(pattern as string | string[]), options),
    mkdir: async (path, options) => await workspace.mkdir(normalizePath(String(path)), options),
    rm: async (path, options) => await workspace.rm(normalizePath(String(path)), options),
    movePath: async (from, to, options) => {
      const source = normalizePath(String(from))
      const target = normalizePath(String(to))
      await copyWorkspacePath(workspace, source, target, options?.overwrite)
      await workspace.rm(source, { recursive: true, force: true })
    },
    copyPath: async (from, to, options) => {
      await copyWorkspacePath(workspace, normalizePath(String(from)), normalizePath(String(to)), options?.overwrite)
    },
  }
}

function toReadToolOptions(options: WorkspaceToolOptions | undefined) {
  return {
    cwd: options?.cwd,
    maxOutputLength: options?.maxOutputLength,
    operations: {
      list: options?.list,
      read: options?.read,
      search: options?.search,
    },
  }
}

function toWriteToolOptions(options: WritableWorkspaceToolOptions | undefined) {
  return {
    cwd: options?.cwd,
    maxOutputLength: options?.maxOutputLength,
    operations: {
      list: options?.list,
      read: options?.read,
      search: options?.search,
      write: {
        appendFile: options?.appendFile !== false,
        copyPath: options?.copyPath !== false,
        deletePath: options?.deletePath !== false,
        makeDir: options?.makeDir !== false,
        movePath: options?.movePath !== false,
        writeFile: options?.writeFile !== false,
      },
    },
  }
}

function createReadonlyFs<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFs<Name> {
  const assets = () => useWorkspaceAssets(name)

  return {
    readFile: async (path, options) => await assets().readFile(path, options),
    stat: async path => await assets().stat(path),
    exists: async path => await assets().exists(path),
    list: async (path, options) => await assets().list(path, options),
    glob: async (pattern, options) => await assets().glob(pattern, options),
  }
}

function createReadonlyFacade<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFacade<Name> {
  const fs = createReadonlyFs(name)

  return {
    fs,
    tools<Options extends WorkspaceToolOptions | undefined = undefined>(options?: Options) {
      return createWorkspaceTools(fs, toReadToolOptions(options)) as WorkspaceReadTools<Options>
    },
  }
}

function createWritableFacade<Name extends WorkspaceName>(name: Name): WritableWorkspaceFacade<Name> {
  const workspace = createLazyWorkspace(name)

  return {
    fs: createWritableFs<Name>(workspace),
    tools<Options extends WritableWorkspaceToolOptions | undefined = undefined>(options?: Options) {
      return createWorkspaceTools(workspace, toWriteToolOptions(options)) as WorkspaceWriteTools<Options>
    },
  }
}

export function useWorkspace<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: { allowWrite: true }): WritableWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: UseWorkspaceOptions = {}): WorkspaceFacade<Name> {
  return options.allowWrite ? createWritableFacade(name) : createReadonlyFacade(name)
}
