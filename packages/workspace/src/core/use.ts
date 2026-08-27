import {
  createWorkspaceTools,
  type ShellEnabled,
  type WorkspaceMaterializeSourcesResult,
  type WorkspaceReadOperations,
  type WorkspaceShellResult,
  type WorkspaceWriteOperations,
  type WorkspaceWriteToolMap,
} from "../ai.ts"
import { useWorkspaceAssets } from "../asset-registry.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"

import { workspaceError } from "./errors.ts"
import { appendWorkspaceFile, copyWorkspacePath } from "../fs-ops.ts"
import { normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern } from "./path.ts"
import { useRegisteredWorkspace } from "./registry.ts"
import { createWorkspace } from "./workspace.ts"
import { attachWorkspaceSourceRequestExecution, getWorkspaceSourceRequestExecution } from "../sources/request-execution.ts"
import { workspaceStoreTarget, type WorkspaceStoreTargetCarrier } from "../storage/target.ts"
import { forwardWorkspaceMetadataTarget, workspaceMetadataTarget, type WorkspaceMetadataTargetCarrier } from "../storage/metadata-target.ts"
import { createHostedWorkspaceSession } from "../session/host.ts"

import type { Tool, ToolSet } from "ai"
import type {
  DiffOptions,
  GlobOptions,
  ListOptions,
  MkdirOptions,
  ReadFileOptions,
  ReadFileResult,
  RmOptions,
  Workspace,
  WorkspaceDefinition,
  WorkspaceAssetPath,
  WorkspaceAssets,
  WorkspaceContent,
  WorkspaceCapabilities,
  WorkspaceEntry,
  WorkspaceSessionOptions,
  WorkspaceName,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceSession,
  WorkspaceStat,
  WorkspaceDiff,
  WorkspaceMaterializeSourcesOptions,
  WorkspacePublishOptions,
  WorkspaceRebaseOptions,
  WorkspaceSnapshot,
  WorkspaceSourceSyncResult,
  WorkspaceSyncOptions,
  WriteFileOptions,
  SnapshotOptions,
} from "./types.ts"

type WorkspaceWritablePath<Name extends WorkspaceName> = WorkspaceAssetPath<Name> | (string & {})

type WorkspaceWithDefinitionSync = Workspace & {
  __syncWorkspaceDefinition?: (abortSignal?: AbortSignal) => Promise<void>
}

async function waitForWorkspaceSync(pending: Promise<void>, signal?: AbortSignal) {
  if (!signal) return await pending
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  }
  finally {
    signal.removeEventListener("abort", onAbort)
  }
}

export interface UseWorkspaceOptions {
  definition?: WorkspaceDefinition
  mode?: "read" | "write"
}

export interface WorkspaceFacadeToolOptions extends WorkspaceReadOperations {
  broadSearchPaths?: string[]
  cwd?: string
  maxShellCalls?: number
  maxOutputLength?: number
  timeout?: number
}

export interface WritableWorkspaceFacadeToolOptions extends WorkspaceFacadeToolOptions, WorkspaceWriteOperations {}

type EnabledWriteCapability<Options, Key extends keyof WorkspaceWriteOperations> = Options extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

export type WorkspaceReadTools<Options = undefined> = ((ShellEnabled<Options> extends true
  ? { shell: Tool<{ command: string }, WorkspaceShellResult> }
  : {}) & (Options extends { materialize: true }
    ? { materialize_sources: Tool<{ path?: string, sources?: string[] }, WorkspaceMaterializeSourcesResult> }
    : {}) & ToolSet)

export type WorkspaceWriteTools<Options = undefined> = WorkspaceReadTools<Options> & {
  [Key in keyof WorkspaceWriteToolMap as EnabledWriteCapability<Options, Key> extends true ? Key : never]: WorkspaceWriteToolMap[Key]
} & ToolSet

export type WorkspaceReadToolSet = WorkspaceReadTools & {
  inspect: <Options extends WorkspaceFacadeToolOptions | undefined = undefined>(options?: Options) => WorkspaceReadTools<Options>
  none: () => ToolSet
}

export type WorkspaceWriteToolSet = WorkspaceWriteTools & {
  inspect: <Options extends WorkspaceFacadeToolOptions | undefined = undefined>(options?: Options) => WorkspaceReadTools<Options>
  none: () => ToolSet
  write: <Options extends WritableWorkspaceFacadeToolOptions | undefined = undefined>(options?: Options) => WorkspaceWriteTools<Options>
}

export type ReadonlyWorkspaceFs<Name extends WorkspaceName = WorkspaceName> = WorkspaceAssets<WorkspaceAssetPath<Name>>

export interface HistoryCheckpoint {
  createdAt: string
  id: string
  name?: string
}

export interface HistoryCheckpointOptions {
  message?: string
}

export interface History<TCheckpoint extends HistoryCheckpoint = HistoryCheckpoint> {
  checkpoint(options?: HistoryCheckpointOptions): Promise<TCheckpoint>
}

export interface WritableWorkspaceFs<Name extends WorkspaceName = WorkspaceName> {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: WorkspaceWritablePath<Name>, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: WorkspaceWritablePath<Name>, content: WorkspaceContent, options?: WriteFileOptions): Promise<string>
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
  getMeta?(key: string): Promise<unknown>
  tools: WorkspaceReadToolSet
}

export interface WorkspaceHistory extends History<WorkspaceSnapshot> {
  rebase(options?: WorkspaceRebaseOptions): Promise<void>
}

export interface WritableWorkspaceFacade<Name extends WorkspaceName = WorkspaceName> {
  capabilities(): Promise<WorkspaceCapabilities>
  diff(options?: DiffOptions): Promise<WorkspaceDiff>
  fs: WritableWorkspaceFs<Name>
  history: WorkspaceHistory
  getMeta?(key: string): Promise<unknown>
  materializeSources(options?: WorkspaceMaterializeSourcesOptions): Promise<WorkspaceMaterializeSourcesResult>
  publish(options?: WorkspacePublishOptions): Promise<void>
  setMeta?(key: string, value: unknown): Promise<void>
  snapshot(options?: SnapshotOptions): Promise<WorkspaceSnapshot>
  startSession(options?: WorkspaceSessionOptions): Promise<WorkspaceSession>
  sync(options: WorkspaceSyncOptions): Promise<WorkspaceSourceSyncResult>
  tools: WorkspaceWriteToolSet
}

export type WorkspaceFacade<Name extends WorkspaceName = WorkspaceName, Mode extends UseWorkspaceOptions["mode"] = "read"> =
  Mode extends "write" ? WritableWorkspaceFacade<Name> : ReadonlyWorkspaceFacade<Name>

function normalizePath(path: string, allowEmpty = false) {
  const reserved = normalizeSafeWorkspacePath(path, { allowEmpty, allowReserved: true })
  if (isGeneratedSourceDescriptorPath(reserved)) return reserved
  return normalizeSafeWorkspacePath(path, { allowEmpty })
}

function normalizeListPath(path = "") {
  return normalizePath(path, true)
}

function normalizePattern(pattern: string | string[]) {
  return Array.isArray(pattern) ? pattern.map(normalizeWorkspacePattern) : normalizeWorkspacePattern(pattern)
}

function normalizeWorkspacePattern(pattern: string) {
  const reserved = normalizeSafeWorkspacePath(pattern, { allowEmpty: true, allowReserved: true, pattern: true })
  if (isGeneratedSourceDescriptorPath(reserved)) return reserved
  return normalizeSafeWorkspacePattern(pattern)
}

function isGeneratedSourceDescriptorPath(path: string): boolean {
  return path === ".vitehub/sources" || path.startsWith(".vitehub/sources/")
}

async function materializeWorkspaceSources(workspace: Workspace, options?: WorkspaceMaterializeSourcesOptions) {
  if (!workspace.materializeSources)
    throw workspaceError("[vitehub] Workspace source materialization is unavailable.")

  return await workspace.materializeSources(options)
}

function createLazyWorkspace(name: WorkspaceName, definition?: WorkspaceDefinition): Workspace {
  let workspacePromise: Promise<Workspace> | undefined
  let syncPromise: Promise<void> | undefined
  let syncAbortSignal: AbortSignal | undefined

  async function resolveWorkspace() {
    workspacePromise ||= definition ? Promise.resolve(createWorkspace(definition)) : useRegisteredWorkspace(name)
    return await workspacePromise
  }

  async function resolveSyncedWorkspace(abortSignal?: AbortSignal) {
    const workspace = await resolveWorkspace()
    while (true) {
      if (!syncPromise) {
        const next = (workspace as WorkspaceWithDefinitionSync).__syncWorkspaceDefinition?.(abortSignal) ?? Promise.resolve()
        syncPromise = next
        syncAbortSignal = abortSignal
        next.catch(() => {
          if (syncPromise === next) {
            syncPromise = undefined
            syncAbortSignal = undefined
          }
        })
      }
      const current = syncPromise
      const currentAbortSignal = syncAbortSignal
      try {
        await waitForWorkspaceSync(current, abortSignal)
        return workspace
      }
      catch (error) {
        if (abortSignal?.aborted || !currentAbortSignal?.aborted) throw error
        if (syncPromise === current) {
          syncPromise = undefined
          syncAbortSignal = undefined
        }
      }
    }
  }

  const workspace = {
    async [workspaceMetadataTarget]() {
      const resolved = await resolveWorkspace()
      return (resolved as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]?.()
    },
    name,
    async capabilities() {
      const resolved = await resolveWorkspace()
      return await resolved.capabilities?.() ?? { conditionalWrites: false }
    },
    async [workspaceStoreTarget]() {
      const resolved = await resolveWorkspace() as Workspace & { [workspaceStoreTarget]?: () => unknown }
      return await resolved[workspaceStoreTarget]?.()
    },
    async sync(options) {
      const resolved = await resolveWorkspace()
      const next = resolved.sync(options)
      syncPromise = next.then(() => undefined)
      next.catch(() => { syncPromise = undefined })
      return await next
    },
    async readFile(path, options) {
      return await (await resolveSyncedWorkspace()).readFile(normalizePath(path), options as never)
    },
    async writeFile(path, content, options) {
      return await (await resolveSyncedWorkspace()).writeFile(normalizePath(path), content, options)
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
    async materializeSources(options) {
      return await materializeWorkspaceSources(await resolveSyncedWorkspace(options?.abortSignal), options)
    },
    async publish(options) {
      if (syncPromise) await syncPromise
      await (await resolveWorkspace()).publish(options)
    },
    async snapshot(options) {
      return await (await resolveSyncedWorkspace()).snapshot(options)
    },
    async rebase(options) {
      await (await resolveSyncedWorkspace()).rebase({
        ...options,
        takeRemote: options?.takeRemote?.map(path => normalizePath(path)),
      })
    },
    async diff(options) {
      return await (await resolveSyncedWorkspace()).diff(options)
    },
    async getMeta(key) {
      return await (await resolveWorkspace()).getMeta?.(key)
    },
    async setMeta(key, value) {
      await (await resolveWorkspace()).setMeta?.(key, value)
    },
    async startSession(options) {
      return await (await resolveSyncedWorkspace()).startSession(options)
    },
  } as Workspace

  return attachWorkspaceSourceRequestExecution(workspace, {
    async executeSourceRequest(input) {
      const resolved = await resolveSyncedWorkspace()
      const executor = getWorkspaceSourceRequestExecution(resolved)
      if (!executor) throw new Error("[vitehub] No API-backed Source request executor is available for this workspace.")
      return await executor.executeSourceRequest(input)
    },
  })
}

function createWritableFs<Name extends WorkspaceName>(name: Name, workspace: Workspace): WritableWorkspaceFs<Name> {
  return attachWorkspaceSourceRequestExecution({
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
  }, getWorkspaceSourceRequestExecution(workspace))
}

function useOptionalWorkspaceAssets<Name extends WorkspaceName>(name: Name): WorkspaceAssets<WorkspaceAssetPath<Name>> | undefined {
  try {
    return useWorkspaceAssets(name)
  }
  catch (error) {
    if (getViteHubErrorShape(error)?.code === "WORKSPACE_NOT_FOUND") return undefined
    throw error
  }
}

async function ignoreMissingWorkspace<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation()
  }
  catch (error) {
    if (isMissingWorkspaceRead(error)) return undefined
    throw error
  }
}

function isMissingWorkspaceRead(error: unknown) {
  return getViteHubErrorShape(error)?.code === "WORKSPACE_NOT_FOUND"
    || (error instanceof Error && error.message.includes("Workspace file does not exist:"))
    || (error instanceof Error && error.message.includes("Workspace path does not exist:"))
}

function mergeEntries(primary: WorkspaceEntry[] = [], fallback: WorkspaceEntry[] = []) {
  const entries = new Map<string, WorkspaceEntry>()
  for (const entry of fallback) entries.set(entry.path, entry)
  for (const entry of primary) entries.set(entry.path, entry)
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function mergeSearchHits(primary: WorkspaceSearchHit[] = [], fallback: WorkspaceSearchHit[] = []) {
  const seen = new Set<string>()
  return [...primary, ...fallback].filter((hit) => {
    const key = `${hit.path}:${hit.line}:${hit.column}:${hit.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createReadonlyFs<Name extends WorkspaceName>(
  name: Name,
  workspace: Workspace,
): ReadonlyWorkspaceFs<Name> {
  const assets = useOptionalWorkspaceAssets(name)
  let readonlyFs: ReadonlyWorkspaceFs<Name>
  readonlyFs = attachWorkspaceSourceRequestExecution({
    readFile: async (path, options) => {
      const normalized = normalizePath(path)
      try {
        return await workspace.readFile(normalized, options as never)
      }
      catch (error) {
        if (assets && isMissingWorkspaceRead(error)) {
          return await assets.readFile(normalized as WorkspaceAssetPath<Name>, options as never)
        }
        throw error
      }
    },
    stat: async (path) => {
      const normalized = normalizePath(path)
      try {
        return await workspace.stat(normalized)
      }
      catch (error) {
        if (assets && isMissingWorkspaceRead(error)) {
          return await assets.stat(normalized as WorkspaceAssetPath<Name>)
        }
        throw error
      }
    },
    exists: async (path) => {
      const normalized = normalizePath(path)
      return await ignoreMissingWorkspace(() => workspace.exists(normalized))
        ?? (assets ? await assets.exists(normalized as WorkspaceAssetPath<Name>) : false)
    },
    list: async (path, options) => {
      const normalized = path ? normalizeListPath(path) : ""
      const workspaceEntries = await ignoreMissingWorkspace(() => workspace.list(normalized, options)) ?? []
      if (normalized && workspaceEntries.length) return workspaceEntries
      let assetEntries = assets ? await assets.list(normalized as WorkspaceAssetPath<Name>, options) : []
      if (!normalized && options?.recursive && workspaceEntries.length) {
        const workspaceRoots = new Set(workspaceEntries.filter(entry => entry.type === "directory").map(entry => entry.path.split("/")[0]))
        assetEntries = assetEntries.filter(entry => !workspaceRoots.has(entry.path.split("/")[0]))
      }
      return mergeEntries(assetEntries, workspaceEntries)
    },
    glob: async (pattern, options) => {
      const normalized = normalizePattern(pattern as string | string[])
      const assetEntries = assets ? await assets.glob(normalized as WorkspaceAssetPath<Name>, options) : []
      const workspaceEntries = await ignoreMissingWorkspace(() => workspace.glob(normalized, options)) ?? []
      return mergeEntries(assetEntries, workspaceEntries)
    },
    search: async (query) => {
      const normalized = {
        ...query,
        cwd: query.cwd ? normalizeListPath(query.cwd) : query.cwd,
        paths: query.paths?.map(path => normalizeListPath(path)),
      }
      const limit = normalized.limit ?? 100
      const assetHits = assets ? await assets.search(normalized) : []
      const workspaceHits = await ignoreMissingWorkspace(() => workspace.search(normalized)) ?? []
      return mergeSearchHits(assetHits, workspaceHits).slice(0, limit)
    },
    materializeSources: async options => await workspace.materializeSources?.(options) ?? {
      bytes: 0,
      directories: 0,
      durationMs: 0,
      files: 0,
      path: options?.path || "",
      sources: [],
    },
    startSession: async (options?: WorkspaceSessionOptions) => {
      if (!assets || !options?.host) return await workspace.startSession(options)
      const overlay = Object.assign(Object.create(workspace) as Workspace, {
        exists: readonlyFs.exists,
        glob: readonlyFs.glob,
        list: readonlyFs.list,
        readFile: readonlyFs.readFile,
        search: readonlyFs.search,
        stat: readonlyFs.stat,
      })
      return await createHostedWorkspaceSession(overlay, { ...options, host: options.host })
    },
  }, getWorkspaceSourceRequestExecution(workspace))
  return readonlyFs
}

function toReadOperations(options: WorkspaceFacadeToolOptions | undefined): WorkspaceReadOperations {
  return { list: options?.list, materialize: options?.materialize ?? true, read: options?.read, search: options?.search }
}

function toWriteOperations(options: WritableWorkspaceFacadeToolOptions | undefined) {
  return {
    ...toReadOperations(options),
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

function createDefaultToolSet<TOptions, TDefaultTools extends ToolSet>(
  createTools: (options?: TOptions) => ToolSet,
) {
  return createTools() as TDefaultTools
}

function emptyTools(): ToolSet {
  return {}
}

export function useWorkspace<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: { mode: "read" }): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: { mode: "write" }): WritableWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options?: UseWorkspaceOptions): ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name> {
  if (options?.mode === "write") {
    const workspace = createLazyWorkspace(name, options.definition)
    const createTools = (opts?: WritableWorkspaceFacadeToolOptions) => createWorkspaceTools(workspace, {
      broadSearchPaths: opts?.broadSearchPaths,
      cwd: opts?.cwd,
      maxShellCalls: opts?.maxShellCalls,
      maxOutputLength: opts?.maxOutputLength,
      operations: toWriteOperations(opts),
      timeout: opts?.timeout,
    })
    const createReadTools = (opts?: WorkspaceFacadeToolOptions) => createWorkspaceTools(createReadonlyFs(name, workspace), {
      broadSearchPaths: opts?.broadSearchPaths,
      cwd: opts?.cwd,
      maxShellCalls: opts?.maxShellCalls,
      maxOutputLength: opts?.maxOutputLength,
      operations: toReadOperations(opts),
      timeout: opts?.timeout,
    })
    const tools = createDefaultToolSet<
      WritableWorkspaceFacadeToolOptions,
      WorkspaceWriteTools
    >(createTools) as WritableWorkspaceFacade<Name>["tools"]
    tools.inspect = createReadTools as WritableWorkspaceFacade<Name>["tools"]["inspect"]
    tools.write = createTools as WritableWorkspaceFacade<Name>["tools"]["write"]
    tools.none = emptyTools
    return {
      [workspaceStoreTarget]: async () => {
        return await (workspace as Workspace & WorkspaceStoreTargetCarrier)[workspaceStoreTarget]?.()
      },
      capabilities: async () => await workspace.capabilities!(),
      diff: async options => await workspace.diff(options),
      fs: createWritableFs(name, workspace),
      history: {
        checkpoint: async options => await workspace.snapshot({ name: options?.message }),
        rebase: async options => await workspace.rebase(options),
      },
      getMeta: async key => await workspace.getMeta?.(key),
      materializeSources: async options => await materializeWorkspaceSources(workspace, options),
      publish: async options => await workspace.publish(options),
      setMeta: async (key, value) => await workspace.setMeta?.(key, value),
      snapshot: async options => await workspace.snapshot(options),
      startSession: async options => await workspace.startSession(options),
      sync: async options => await workspace.sync(options),
      tools,
    } as WritableWorkspaceFacade<Name> & WorkspaceStoreTargetCarrier
  }

  const workspace = createLazyWorkspace(name, options?.definition)
  const fs = createReadonlyFs(name, workspace)
  const createTools = (opts?: WorkspaceFacadeToolOptions) => createWorkspaceTools(fs, {
    broadSearchPaths: opts?.broadSearchPaths,
    cwd: opts?.cwd,
    maxShellCalls: opts?.maxShellCalls,
    maxOutputLength: opts?.maxOutputLength,
    operations: toReadOperations(opts),
    timeout: opts?.timeout,
  })
  const tools = createDefaultToolSet<
    WorkspaceFacadeToolOptions,
    WorkspaceReadTools
  >(createTools) as ReadonlyWorkspaceFacade<Name>["tools"]
  tools.inspect = createTools as ReadonlyWorkspaceFacade<Name>["tools"]["inspect"]
  tools.none = emptyTools
  const facade = {
    fs,
    getMeta: async (key: string) => await workspace.getMeta?.(key),
    tools,
  }
  forwardWorkspaceMetadataTarget(workspace, facade)
  return facade
}
