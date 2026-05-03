import type {
  WorkspaceReadOperations,
  WorkspaceToolOperations,
  WorkspaceTools,
  WorkspaceWriteOperations,
} from "./ai.ts"
import { useWorkspaceAssets } from "./asset-registry.ts"
import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
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
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceStat,
  WriteFileOptions,
} from "./types.ts"

type WorkspaceWritablePath<Name extends WorkspaceName> = WorkspaceAssetPath<Name> | (string & {})

export interface UseWorkspaceOptions {
  allowWrite?: boolean
}

export interface WorkspaceFacadeToolOptions extends WorkspaceReadOperations {}

export interface WritableWorkspaceFacadeToolOptions extends WorkspaceFacadeToolOptions, WorkspaceWriteOperations {}

type ReadOperationSelection<Options> = Options extends WorkspaceReadOperations ? Options : true

type WriteOperationSelection<Options> = Options extends WorkspaceWriteOperations
  ? {
      appendFile: Options extends { appendFile: false } ? false : true
      copyPath: Options extends { copyPath: false } ? false : true
      deletePath: Options extends { deletePath: false } ? false : true
      makeDir: Options extends { makeDir: false } ? false : true
      movePath: Options extends { movePath: false } ? false : true
      writeFile: Options extends { writeFile: false } ? false : true
    }
  : true

export type WorkspaceReadTools<Options = undefined> = WorkspaceTools<{ read: ReadOperationSelection<Options> }>

export type WorkspaceWriteTools<Options = undefined> = WorkspaceTools<{
  read: ReadOperationSelection<Options>
  write: WriteOperationSelection<Options>
}>

export type WorkspaceReadToolSet = {
  <Options extends WorkspaceFacadeToolOptions | undefined = undefined>(options?: Options): Promise<WorkspaceReadTools<Options>>
}

export type WorkspaceWriteToolSet = {
  <Options extends WritableWorkspaceFacadeToolOptions | undefined = undefined>(options?: Options): Promise<WorkspaceWriteTools<Options>>
}

export type ReadonlyWorkspaceFs<Name extends WorkspaceName = WorkspaceName> = WorkspaceAssets<WorkspaceAssetPath<Name>>

export interface WritableWorkspaceFs<Name extends WorkspaceName = WorkspaceName> {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: WorkspaceWritablePath<Name>, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: WorkspaceWritablePath<Name>, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
  appendFile(path: WorkspaceWritablePath<Name>, content: string): Promise<void>
  stat(path: WorkspaceWritablePath<Name>): Promise<WorkspaceStat>
  exists(path: WorkspaceWritablePath<Name>): Promise<boolean>
  list(path?: WorkspaceWritablePath<Name> | "", options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: WorkspaceWritablePath<Name> | Array<WorkspaceWritablePath<Name>>, options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  mkdir(path: WorkspaceWritablePath<Name>, options?: MkdirOptions): Promise<void>
  rm(path: WorkspaceWritablePath<Name>, options?: RmOptions): Promise<void>
  movePath(from: WorkspaceWritablePath<Name>, to: WorkspaceWritablePath<Name>, options?: { overwrite?: boolean }): Promise<void>
  copyPath(from: WorkspaceWritablePath<Name>, to: WorkspaceWritablePath<Name>, options?: { overwrite?: boolean }): Promise<void>
}

export interface ReadonlyWorkspaceFacade<Name extends WorkspaceName = WorkspaceName> {
  fs: ReadonlyWorkspaceFs<Name>
  tools: WorkspaceReadToolSet
}

export interface WritableWorkspaceFacade<Name extends WorkspaceName = WorkspaceName> {
  fs: WritableWorkspaceFs<Name>
  tools: WorkspaceWriteToolSet
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
    if (!syncPromise) {
      const next = workspace.sync()
      syncPromise = next
      next.catch(() => { syncPromise = undefined })
    }
    await syncPromise
    return workspace
  }

  const workspace = {
    name,
    async sync(options) {
      const resolved = await resolveWorkspace()
      const next = resolved.sync(options)
      syncPromise = next
      next.catch(() => { syncPromise = undefined })
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
    async search(query) {
      return await (await resolveSyncedWorkspace()).search({
        ...query,
        cwd: query.cwd ? normalizeListPath(query.cwd) : query.cwd,
        paths: query.paths?.map(path => normalizeListPath(path)),
      })
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
  } as Workspace

  return workspace
}

function createWritableFs<Name extends WorkspaceName>(workspace: Workspace): WritableWorkspaceFs<Name> {
  return {
    readFile: async (path, options) => await workspace.readFile(normalizePath(path), options as never),
    writeFile: async (path, content, options) => await workspace.writeFile(normalizePath(path), content, options),
    appendFile: async (path, content) => await appendWorkspaceFile(workspace, normalizePath(path), content),
    stat: async path => await workspace.stat(normalizePath(path)),
    exists: async path => await workspace.exists(normalizePath(path)),
    list: async (path, options) => await workspace.list(path ? normalizeListPath(path) : "", options),
    glob: async (pattern, options) => await workspace.glob(normalizePattern(pattern as string | string[]), options),
    search: async query => await workspace.search({
      ...query,
      cwd: query.cwd ? normalizeListPath(query.cwd) : query.cwd,
      paths: query.paths?.map(path => normalizeListPath(path)),
    }),
    mkdir: async (path, options) => await workspace.mkdir(normalizePath(path), options),
    rm: async (path, options) => await workspace.rm(normalizePath(path), options),
    movePath: async (from, to, options) => {
      const source = normalizePath(from)
      await copyWorkspacePath(workspace, source, normalizePath(to), options?.overwrite)
      await workspace.rm(source, { recursive: true, force: true })
    },
    copyPath: async (from, to, options) => await copyWorkspacePath(workspace, normalizePath(from), normalizePath(to), options?.overwrite),
  }
}

function toReadOperations(options: WorkspaceFacadeToolOptions | undefined): WorkspaceToolOperations["read"] {
  if (!options) {
    return true
  }

  return {
    exists: options.exists !== false,
    list: options.list !== false,
    readFile: options.readFile !== false,
    search: options.search !== false,
    stat: options.stat !== false,
  }
}

function toWriteOperations(options: WritableWorkspaceFacadeToolOptions | undefined): WorkspaceToolOperations {
  return {
    read: toReadOperations(options),
    write: {
      appendFile: options?.appendFile !== false,
      copyPath: options?.copyPath !== false,
      deletePath: options?.deletePath !== false,
      makeDir: options?.makeDir !== false,
      movePath: options?.movePath !== false,
      writeFile: options?.writeFile !== false,
    },
  }
}

async function createWorkspaceToolSet<Operations extends WorkspaceToolOperations>(
  input: Workspace | WorkspaceAssets,
  operations: Operations,
) {
  const { createWorkspaceTools } = await import("./ai.ts")
  return createWorkspaceTools(input, { operations })
}

export function useWorkspace<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: { allowWrite: true }): WritableWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options?: UseWorkspaceOptions): ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name> {
  if (options?.allowWrite) {
    const workspace = createLazyWorkspace(name)
    const createTools = async (opts?: WritableWorkspaceFacadeToolOptions) =>
      await createWorkspaceToolSet(workspace, toWriteOperations(opts))

    return {
      fs: createWritableFs<Name>(workspace),
      tools: createTools as WritableWorkspaceFacade<Name>["tools"],
    }
  }

  const fs = useWorkspaceAssets(name)
  const createTools = async (opts?: WorkspaceFacadeToolOptions) =>
    await createWorkspaceToolSet(fs, { read: toReadOperations(opts) })

  return {
    fs,
    tools: createTools as ReadonlyWorkspaceFacade<Name>["tools"],
  }
}
