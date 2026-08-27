import { createWorkspaceTools } from "../ai.ts"
import { workspaceError } from "../core/errors.ts"
import { normalizeWorkspacePath } from "../core/path.ts"
import { createWorkspaceWritePolicy } from "../core/rules.ts"
import { appendWorkspaceFile, copyWorkspacePath } from "../fs-ops.ts"
import { createBasicWorkspaceSession } from "../session/basic.ts"
import { createMemoryWorkspaceStore } from "../storage/memory.ts"
import { forwardWorkspaceStoreTarget } from "../storage/target.ts"
import { copyWorkspaceSourceMetadata, normalizeWorkspaceSource, normalizeWorkspaceSources, workspaceSourceRequestDescriptorPath } from "./config.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import { markLiveWorkspaceSource } from "./live.ts"
import { attachWorkspaceSourceRequestExecution, createWorkspaceSourceRequestExecution, getWorkspaceSourceRequestExecution } from "./request-execution.ts"
import { resolveWorkspacePath } from "./resolver.ts"
import { createWorkspaceSourceView } from "./view.ts"

import type {
  ReadonlyWorkspaceFacade,
  WorkspaceFacadeToolOptions,
  WorkspaceReadToolSet,
  WorkspaceWriteToolSet,
  WritableWorkspaceFacade,
  WritableWorkspaceFacadeToolOptions,
} from "../core/use.ts"
import type {
  GlobOptions,
  ListOptions,
  Workspace,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceName,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceStore,
  WorkspaceSession,
  WorkspaceSessionOptions,
  WorkspaceWriteInput,
  WorkspaceSelectedScope,
  WorkspaceSource,
  WorkspaceSourceInput,
  WorkspaceSourceResolutionContext,
  WorkspaceSourceResolutionInvocation,
  WorkspaceSourceResolver,
} from "../core/types.ts"

export interface WorkspaceSourceResolutionOptions {
  invocation: WorkspaceSourceResolutionInvocation<object>
  overlay?: boolean
  selectedWorkspaceScope?: WorkspaceSelectedScope<string>
}

export interface WorkspaceSourceResolutionFacade<Name extends WorkspaceName = WorkspaceName> {
  definition: WorkspaceDefinition
  workspace: ReadonlyWorkspaceFacade<Name>
}

type WorkspaceMetadataTarget = {
  getMeta?(key: string): Promise<unknown>
  setMeta?(key: string, value: unknown): Promise<void>
}

export function hasWorkspaceSourceResolvers(definition: Pick<WorkspaceDefinition, "sources"> | undefined): boolean {
  return normalizeWorkspaceSources(definition?.sources).some(source => typeof source.source.resolve === "function")
}

function isWritableWorkspaceFacade<Name extends WorkspaceName>(workspace: ReadonlyWorkspaceFacade<Name>): workspace is WritableWorkspaceFacade<Name> {
  return typeof (workspace as WritableWorkspaceFacade<Name>).fs.writeFile === "function"
}

function workspaceSessionStarter<Name extends WorkspaceName>(workspace: ReadonlyWorkspaceFacade<Name>): Pick<Workspace, "startSession"> | undefined {
  return typeof (workspace as ReadonlyWorkspaceFacade<Name> & Partial<Pick<Workspace, "startSession">>).startSession === "function"
    ? workspace as ReadonlyWorkspaceFacade<Name> & Pick<Workspace, "startSession">
    : undefined
}

function writeOperations(options: WritableWorkspaceFacadeToolOptions | undefined) {
  return {
    appendFile: options?.appendFile !== false,
    copyPath: options?.copyPath !== false,
    deletePath: options?.deletePath !== false,
    makeDir: options?.makeDir !== false,
    movePath: options?.movePath !== false,
    writeFile: options?.writeFile !== false,
  }
}

function createOverlaySourceStore<Name extends WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
  fallback: (path: string) => boolean,
): WorkspaceStore {
  const memory = createMemoryWorkspaceStore()

  async function readBaseFile(path: string): Promise<WorkspaceFile | undefined> {
    if (!fallback(path)) return
    if (!await workspace.fs.exists(path as never)) return
    const stat = await workspace.fs.stat(path as never).catch(() => undefined)
    if (stat?.type === "directory") return
    return {
      content: await workspace.fs.readFile(path as never, { encoding: "binary" } as never) as Uint8Array,
      mediaType: stat?.mediaType,
      path,
    }
  }

  async function baseEntries(path = "", options?: ListOptions) {
    try {
      return (await workspace.fs.list(path as never, options)).filter(entry => fallback(entry.path))
    }
    catch {
      return []
    }
  }

  async function baseGlob(pattern: string | string[], options?: GlobOptions) {
    try {
      return (await workspace.fs.glob(pattern as never, options)).filter(entry => fallback(entry.path))
    }
    catch {
      return []
    }
  }

  async function baseStat(path: string) {
    if (!fallback(path)) return
    try {
      return await workspace.fs.stat(path as never)
    }
    catch {
      return undefined
    }
  }

  return {
    async readFile(path) {
      return await memory.readFile(path) || await readBaseFile(path)
    },
    async writeFile(path, file) {
      await memory.writeFile(path, file)
    },
    async list(path, options) {
      return mergeEntries(await baseEntries(path, options), await memory.list(path, options))
    },
    async glob(pattern, options) {
      return mergeEntries(await baseGlob(pattern, options), await memory.glob(pattern, options))
    },
    async stat(path) {
      return await memory.stat(path) || await baseStat(path)
    },
    async mkdir(path, options) {
      await memory.mkdir(path, options)
    },
    async rm(path, options) {
      await memory.rm(path, options)
    },
    async snapshot(options) {
      return await memory.snapshot(options)
    },
    async diff(options) {
      return await memory.diff(options)
    },
    async getMeta(key) {
      return await memory.getMeta?.(key)
    },
    async setMeta(key, value) {
      await memory.setMeta?.(key, value)
    },
  }
}

function createWritableFacadeStore(workspace: WritableWorkspaceFacade): WorkspaceStore {
  const meta = new Map<string, unknown>()
  const metadata = workspace as WritableWorkspaceFacade & WorkspaceMetadataTarget
  const store: WorkspaceStore = {
    async readFile(path) {
      try {
        const stat = await workspace.fs.stat(path as never)
        if (stat.type === "directory") return
        return {
          content: await workspace.fs.readFile(path as never, { encoding: "binary" } as never) as Uint8Array,
          mediaType: stat.mediaType,
          path,
        }
      }
      catch {
        return undefined
      }
    },
    async writeFile(path, file) {
      await workspace.fs.writeFile(path as never, file.content, { mediaType: file.mediaType })
    },
    async list(path, options) {
      return await workspace.fs.list(path as never, options)
    },
    async glob(pattern, options) {
      return await workspace.fs.glob(pattern as never, options)
    },
    async stat(path) {
      try {
        return await workspace.fs.stat(path as never)
      }
      catch {
        return undefined
      }
    },
    async mkdir(path, options) {
      await workspace.fs.mkdir(path as never, options)
    },
    async rm(path, options) {
      await workspace.fs.rm(path as never, options)
    },
    async snapshot(options) {
      return await workspace.snapshot(options)
    },
    async rebase(options) {
      await workspace.history.rebase(options)
    },
    async diff(options) {
      return await workspace.diff(options)
    },
    async getMeta(key) {
      if (metadata.getMeta) return await metadata.getMeta(key)
      return meta.get(key)
    },
    async setMeta(key, value) {
      if (metadata.setMeta) {
        await metadata.setMeta(key, value)
        return
      }
      meta.set(key, value)
    },
  }
  forwardWorkspaceStoreTarget(workspace, store)
  return store
}

async function startOverlayWorkspaceSession(_definition: WorkspaceDefinition, workspace: Workspace, options?: WorkspaceSessionOptions) {
  const host = options?.host
  if (host) {
    const { createHostedWorkspaceSession } = await import("../session/host.ts")
    return await createHostedWorkspaceSession(workspace, { ...options, host })
  }
  return await createBasicWorkspaceSession(workspace, options)
}

export async function resolveWorkspaceSources(
  definition: WorkspaceDefinition,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceDefinition> {
  if (!hasWorkspaceSourceResolvers(definition) && !options.selectedWorkspaceScope) return definition

  const sources: Record<string, WorkspaceSourceInput> = {}
  for (const [key, source] of Object.entries(definition.sources || {})) {
    const resolved = await resolveWorkspaceSource(definition, key, source, options)
    if (resolved) sources[key] = resolved
  }

  return {
    ...definition,
    sources,
  }
}

export async function createWorkspaceSourceResolutionFacade<Name extends WorkspaceName = WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
  definition: WorkspaceDefinition,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceSourceResolutionFacade<Name>> {
  const resolvedDefinition = await resolveWorkspaceSources(definition, options)
  const sourceRequestExecution = createWorkspaceSourceRequestExecution(resolvedDefinition, {
    selectedWorkspaceScope: options.selectedWorkspaceScope,
  }) ?? getWorkspaceSourceRequestExecution(workspace.fs)
  if (!options.overlay && resolvedDefinition === definition && !sourceRequestExecution) return { definition, workspace }

  const selectedWorkspaceScope = options.selectedWorkspaceScope
  const sourceViewDefinition = createScopedSourceViewDefinition(resolvedDefinition, selectedWorkspaceScope)
  const sourceView = createWorkspaceSourceView(sourceViewDefinition, createOverlaySourceStore(workspace, path => !isLazySourcePath(resolvedDefinition, path)))
  const materializeSources = async (options = {}) => await sourceView.materializeSources(options)
  let readWorkspace!: Workspace
  const fs = attachWorkspaceSourceRequestExecution({
    async readFile(path, options) {
      if (isSourcePath(resolvedDefinition, path)) {
        return await sourceView.readFile(path, options as never)
      }
      if (selectedScopeCanRead(selectedWorkspaceScope, path) && await sourceViewHasPath(resolvedDefinition, sourceView, path)) return await sourceView.readFile(path, options as never)
      return await workspace.fs.readFile(path, options as never)
    },
    async stat(path) {
      if (isSourcePath(resolvedDefinition, path)) {
        return await sourceView.stat(path)
      }
      if (selectedScopeCanSee(selectedWorkspaceScope, path) && await sourceViewHasPath(resolvedDefinition, sourceView, path)) return await sourceView.stat(path)
      return await workspace.fs.stat(path)
    },
    async exists(path) {
      if (isSourcePath(resolvedDefinition, path)) return await sourceView.exists(path)
      return selectedScopeCanSee(selectedWorkspaceScope, path) && await sourceViewHasPath(resolvedDefinition, sourceView, path) || await workspace.fs.exists(path)
    },
    async list(path = "", options = {}) {
      const normalized = normalizeWorkspacePath(path)
      if (normalized && isSourcePath(resolvedDefinition, normalized)) {
        return filterScopedEntries(selectedWorkspaceScope, await sourceView.list(normalized, options))
      }
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.list(path as never, options as ListOptions),
        selectedScopeCanSee(selectedWorkspaceScope, normalized) && sourcePathIntersects(resolvedDefinition, normalized) ? sourceView.list(normalized, options) : Promise.resolve([]),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), filterScopedEntries(selectedWorkspaceScope, sourceEntries))
    },
    async glob(pattern, options) {
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.glob(pattern as never, options),
        sourceView.glob(pattern as never, options),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), filterScopedEntries(selectedWorkspaceScope, sourceEntries))
    },
    async search(query) {
      const scopedToSource = searchQueryTargetsSource(resolvedDefinition, query)
      const [baseHits, sourceHits] = await Promise.all([
        scopedToSource ? Promise.resolve([]) : workspace.fs.search(query),
        sourceView.search(query),
      ])
      return mergeHits(filterBaseHits(resolvedDefinition, baseHits), filterScopedHits(selectedWorkspaceScope, sourceHits)).slice(0, query.limit ?? 100)
    },
    materializeSources,
    startSession: async (options) => {
      const paths = options?.paths?.length ? options.paths : [""]
      await Promise.all(paths.map(path => materializeSources({ path })))
      return await startOverlayWorkspaceSession(resolvedDefinition, readWorkspace, options)
    },
  } as ReadonlyWorkspaceFacade<Name>["fs"] & Pick<Workspace, "startSession">, sourceRequestExecution)
  readWorkspace = attachWorkspaceSourceRequestExecution({
    name: resolvedDefinition.name,
    exists: fs.exists,
    glob: fs.glob,
    list: fs.list,
    materializeSources,
    readFile: fs.readFile,
    search: fs.search,
    startSession: fs.startSession,
    stat: fs.stat,
  } as Workspace, sourceRequestExecution)

  const createTools = (options?: WorkspaceFacadeToolOptions) => createWorkspaceTools(fs, {
    broadSearchPaths: options?.broadSearchPaths,
    cwd: options?.cwd,
    maxShellCalls: options?.maxShellCalls,
    maxOutputLength: options?.maxOutputLength,
    operations: {
      list: options?.list,
      materialize: options?.materialize ?? true,
      read: options?.read,
      search: options?.search,
    },
    timeout: options?.timeout,
  })
  const tools = createTools() as WorkspaceReadToolSet
  tools.inspect = createTools as WorkspaceReadToolSet["inspect"]
  tools.none = (() => ({})) as WorkspaceReadToolSet["none"]

  if (isWritableWorkspaceFacade(workspace)) {
    const writePolicy = createWorkspaceWritePolicy(resolvedDefinition)
    const syncStore = createWritableFacadeStore(workspace)
    let writeWorkspace!: Workspace

    async function previousStat(path: string) {
      try {
        return await workspace.fs.stat(path as never)
      }
      catch {
        return undefined
      }
    }

    async function writeWithPolicy<Result = void>(
      input: Omit<WorkspaceWriteInput, "previous" | "rule" | "workspace">,
      write: (input: WorkspaceWriteInput) => Promise<Result>,
      preservePath = false,
    ) {
      await sourceView.assertWritable(input.path)
      const next = await writePolicy.before({
        ...input,
        path: normalizeWorkspacePath(input.path),
        previous: await previousStat(input.path),
        workspace: resolvedDefinition.name,
      })
      try {
        if (preservePath && next.path !== normalizeWorkspacePath(input.path)) {
          throw workspaceError(`[vitehub] Workspace validator cannot rewrite preserved path: ${normalizeWorkspacePath(input.path)} -> ${next.path}.`)
        }
        await sourceView.assertWritable(next.path)
        const result = await write(next)
        await writePolicy.after(next)
        return { input: next, result }
      }
      catch (error) {
        await writePolicy.error(next, error)
        throw error
      }
    }

    function withSessionSourceGuards(session: WorkspaceSession): WorkspaceSession {
      return {
        ...session,
        async mkdir(path, options) {
          await sourceView.assertWritable(path)
          await session.mkdir(path, options)
        },
        async rm(path, options) {
          await sourceView.assertWritable(path)
          await session.rm(path, options)
        },
        async writeFile(path, content, options) {
          await sourceView.assertWritable(path)
          await session.writeFile(path, content, options)
        },
      }
    }

    const writeFs: WritableWorkspaceFacade<Name>["fs"] = attachWorkspaceSourceRequestExecution({
      appendFile: async (path, content) => await appendWorkspaceFile(writeWorkspace, path, content),
      copyPath: async (from, to, options) => await copyWorkspacePath(writeWorkspace, from, to, options?.overwrite),
      exists: fs.exists,
      glob: fs.glob,
      list: fs.list,
      mkdir: async (path, options) => {
        await writeWithPolicy({
          operation: "mkdir",
          path,
        }, async input => await workspace.fs.mkdir(input.path as never, options))
      },
      movePath: async (from, to, options) => {
        await sourceView.assertWritable(from)
        await sourceView.assertWritable(to)
        await copyWorkspacePath(writeWorkspace, from, to, options?.overwrite)
        await writeWorkspace.rm(from, { recursive: true, force: true })
      },
      readFile: fs.readFile,
      rm: async (path, options) => {
        await writeWithPolicy({
          operation: "rm",
          path,
        }, async input => await workspace.fs.rm(input.path as never, options))
      },
      search: fs.search,
      stat: fs.stat,
      writeFile: async (path, content, options) => {
        const { input, result } = await writeWithPolicy({
          content,
          mediaType: options?.mediaType,
          metadata: options?.metadata,
          operation: "writeFile",
          path,
        }, async (next) => {
          const writeOptions = options === undefined && next.mediaType === undefined && next.metadata === undefined
            ? undefined
            : { ...options, mediaType: next.mediaType, metadata: next.metadata }
          return await workspace.fs.writeFile(next.path as never, next.content ?? content, writeOptions)
        }, options?.preservePath)
        return result || input.path
      },
    }, sourceRequestExecution)
    writeWorkspace = attachWorkspaceSourceRequestExecution({
      name: resolvedDefinition.name,
      diff: workspace.diff,
      exists: writeFs.exists,
      glob: writeFs.glob,
      list: writeFs.list,
      materializeSources,
      mkdir: writeFs.mkdir,
      publish: async (options) => {
        const { publishWorkspace } = await import("../lifecycle.ts")
        const resolvedStore = createWritableFacadeStore({ ...workspace, fs: writeFs })
        await publishWorkspace(resolvedDefinition, resolvedStore, options)
      },
      rebase: workspace.history.rebase,
      readFile: writeFs.readFile,
      rm: writeFs.rm,
      search: writeFs.search,
      snapshot: workspace.snapshot,
      startSession: async (options) => {
        const paths = options?.paths?.length ? options.paths : [""]
        await Promise.all(paths.map(path => materializeSources({ path })))
        const startBoxSession: unknown = Reflect.get(workspace, Symbol.for("vitehub.workspace.start-box-session"))
        const session = options?.host
          ? await startOverlayWorkspaceSession(resolvedDefinition, writeWorkspace, options)
          : typeof startBoxSession === "function"
          ? await (startBoxSession as (target: Workspace, options?: WorkspaceSessionOptions) => Promise<WorkspaceSession>)(writeWorkspace, options)
          : await startOverlayWorkspaceSession(resolvedDefinition, writeWorkspace, options)
        return withSessionSourceGuards(session)
      },
      stat: writeFs.stat,
      sync: async (options) => {
        const { syncWorkspaceSources } = await import("./sync.ts")
        return await syncWorkspaceSources(resolvedDefinition, syncStore, options)
      },
      writeFile: writeFs.writeFile,
    }, sourceRequestExecution)
    const createWriteTools = (options?: WritableWorkspaceFacadeToolOptions) => createWorkspaceTools(writeWorkspace as never, {
      broadSearchPaths: options?.broadSearchPaths,
      cwd: options?.cwd,
      maxShellCalls: options?.maxShellCalls,
      maxOutputLength: options?.maxOutputLength,
      operations: {
        list: options?.list,
        materialize: options?.materialize ?? true,
        read: options?.read,
        search: options?.search,
        write: writeOperations(options),
      },
      timeout: options?.timeout,
    })
    const writeTools = createWriteTools() as WorkspaceWriteToolSet
    writeTools.inspect = createTools as WorkspaceWriteToolSet["inspect"]
    writeTools.none = (() => ({})) as WorkspaceWriteToolSet["none"]
    writeTools.write = createWriteTools as WorkspaceWriteToolSet["write"]
    const writableWorkspace: WritableWorkspaceFacade<Name> = {
      ...workspace,
      diff: writeWorkspace.diff,
      fs: writeFs,
      materializeSources,
      publish: writeWorkspace.publish,
      snapshot: writeWorkspace.snapshot,
      startSession: writeWorkspace.startSession,
      sync: writeWorkspace.sync,
      tools: writeTools,
    }

    return {
      definition: resolvedDefinition,
      workspace: writableWorkspace,
    }
  }

  const readonlyWorkspace: ReadonlyWorkspaceFacade<Name> & Partial<Pick<Workspace, "startSession">> = {
    fs,
    tools,
  }
  const starter = workspaceSessionStarter(workspace)
  if (starter) {
    readonlyWorkspace.startSession = async options => await starter.startSession(options)
  }

  return {
    definition: resolvedDefinition,
    workspace: readonlyWorkspace,
  }
}

async function resolveWorkspaceSource(
  definition: WorkspaceDefinition,
  key: string,
  input: WorkspaceSourceInput,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceSourceInput | undefined> {
  const declared = normalizeWorkspaceSource(key, input)
  const source = declared.source
  if (!source.resolve) return selectedScopeIntersectsSource(options.selectedWorkspaceScope, declared) ? input : undefined

  const context: WorkspaceSourceResolutionContext<object, string> = {
    ...Object.fromEntries(options.invocation.context.entries()),
    invocation: options.invocation,
    selectedWorkspaceScope: options.selectedWorkspaceScope,
    source: {
      key,
      mountPath: declared.mountPath,
    },
    workspace: {
      name: definition.name,
      rootDir: definition.rootDir,
      sourceRootDir: definition.sourceRootDir,
    },
  }
  const resolve = source.resolve as WorkspaceSourceResolver<object, string>
  const resolved = await resolve(context)
  if (!resolved) return undefined

  const resolvedSource = withResolvedSourceRuntimeDefaults(applyResolvedWorkspaceSourceBinding(input, resolved))
  const normalized = normalizeWorkspaceSource(key, resolvedSource)
  if (!selectedScopeIntersectsSource(options.selectedWorkspaceScope, normalized)) return undefined

  return copyWorkspaceSourceMetadata(resolvedSource, {
    ...resolvedSource,
    fingerprint: {
      source: resolvedSource.fingerprint,
      sourceResolution: {
        selectedWorkspaceScope: options.selectedWorkspaceScope
          ? {
              all: options.selectedWorkspaceScope.all,
              name: options.selectedWorkspaceScope.name,
              paths: options.selectedWorkspaceScope.paths,
              role: options.selectedWorkspaceScope.role,
              sources: options.selectedWorkspaceScope.sources,
            }
          : undefined,
      },
    },
  })
}

function applyResolvedWorkspaceSourceBinding(input: WorkspaceSourceInput, source: WorkspaceSource): WorkspaceSource {
  if (!isPlainRecord(input)) return source
  const next: WorkspaceSource = { ...source }
  copyWorkspaceSourceMetadata(source, next)
  if (!("source" in input)) {
    return next
  }
  copyDefinedWorkspaceBindingOption(next, input, "cache")
  copyDefinedWorkspaceBindingOption(next, input, "materialize")
  copyDefinedWorkspaceBindingOption(next, input, "mount")
  copyDefinedWorkspaceBindingOption(next, input, "sync")
  copyDefinedWorkspaceBindingOption(next, input, "validate")
  return next
}

function copyDefinedWorkspaceBindingOption<TKey extends "cache" | "materialize" | "mount" | "sync" | "validate">(
  target: WorkspaceSource,
  input: Record<string, unknown>,
  key: TKey,
) {
  if (input[key] !== undefined) {
    target[key] = input[key] as never
  }
}

function withResolvedSourceRuntimeDefaults(source: WorkspaceSource): WorkspaceSource {
  if (source.materialize || source.mount && typeof source.mount === "object" && source.mount.materialize) {
    return source
  }
  if (source.sync) return source
  return copyWorkspaceSourceMetadata(source, { ...source, materialize: "lazy" })
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function isSourcePath(definition: WorkspaceDefinition, path: string): boolean {
  if (isWorkspaceMetadataPath(path)) return false
  return resolveWorkspacePath(definition, path).type === "source"
}

async function sourceViewHasPath(definition: WorkspaceDefinition, sourceView: ReturnType<typeof createWorkspaceSourceView>, path: string): Promise<boolean> {
  if (!sourcePathIntersects(definition, normalizeWorkspacePath(path))) return false
  try {
    return await sourceView.exists(path)
  }
  catch {
    return false
  }
}

function sourcePathIntersects(definition: WorkspaceDefinition, path: string): boolean {
  if (isWorkspaceMetadataPath(path)) return sourceDescriptorPathIntersects(definition, path)
  return normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize !== "none")
    .some(source => pathIntersects(source.mountPath, path))
}

function isWorkspaceMetadataPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalized === ".vitehub" || normalized.startsWith(".vitehub/")
}

function sourceDescriptorPathIntersects(definition: WorkspaceDefinition, path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalizeWorkspaceSources(definition.sources)
    .some(source => source.requestDescriptor && pathIntersects(workspaceSourceRequestDescriptorPath(source.key), normalized))
}

function isLazySourcePath(definition: WorkspaceDefinition, path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "lazy" || source.materialize === "startup")
    .some(source => pathIntersects(source.mountPath, normalized))
}

function searchQueryTargetsSource(definition: WorkspaceDefinition, query: WorkspaceSearchQuery): boolean {
  const paths = query.paths?.length ? query.paths : [query.cwd || ""]
  return paths.every(path => isSourcePath(definition, path))
}

function filterBaseEntries(definition: WorkspaceDefinition, entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter(entry => !isSourcePath(definition, entry.path))
}

function filterBaseHits(definition: WorkspaceDefinition, hits: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  return hits.filter(hit => !isSourcePath(definition, hit.path))
}

function createScopedSourceViewDefinition(
  definition: WorkspaceDefinition,
  scope: WorkspaceSelectedScope | undefined,
): WorkspaceDefinition {
  if (!scope || scope.all) return definition
  const sources: Record<string, WorkspaceSourceInput> = {}
  for (const source of normalizeWorkspaceSources(definition.sources)) {
    sources[source.key] = scopedWorkspaceSource(source, scope)
  }
  return { ...definition, sources }
}

function scopedWorkspaceSource(
  source: ReturnType<typeof normalizeWorkspaceSources>[number],
  scope: WorkspaceSelectedScope,
): WorkspaceSource {
  const scopedLivePaths: Record<string, string> | undefined = source.livePaths ? {} : undefined
  syncScopedLivePaths(scopedLivePaths, source.livePaths, scope)
  const scoped: WorkspaceSource = {
    ...source.source,
    ...(scopedLivePaths
      ? {
          async prepare(ctx) {
            await prepareWorkspaceSource(source.source, ctx)
            syncScopedLivePaths(scopedLivePaths, source.livePaths, scope)
          },
        }
      : {}),
    ...(source.source.getItems
      ? {
          getItems: async ctx => (await source.source.getItems!(ctx))
            .filter(item => selectedScopeCanRead(scope, sourceItemWorkspacePath(source, item.path || item.key))),
        }
      : {}),
    getKeys: async ctx => (await source.source.getKeys(ctx))
      .filter(key => selectedScopeCanRead(scope, sourceItemWorkspacePath(source, key))),
    getItem: async (key, ctx) => {
      const path = sourceItemWorkspacePath(source, key)
      if (!selectedScopeCanRead(scope, path)) {
        throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      }
      return await source.source.getItem(key, ctx)
    },
    ...(source.source.getMeta
      ? {
          getMeta: async (key, ctx) => {
            if (!selectedScopeCanRead(scope, sourceItemWorkspacePath(source, key))) return undefined
            return await source.source.getMeta!(key, ctx)
          },
        }
      : {}),
  }
  if (!source.requestDescriptor || selectedScopeCanRead(scope, workspaceSourceRequestDescriptorPath(source.key))) {
    copyWorkspaceSourceMetadata(source.source, scoped)
  }
  if (scopedLivePaths) markLiveWorkspaceSource(scoped, scopedLivePaths)
  return scoped
}

function syncScopedLivePaths(target: Record<string, string> | undefined, source: Record<string, string> | undefined, scope: WorkspaceSelectedScope) {
  if (!target || !source) return
  for (const path of Object.keys(target)) delete target[path]
  for (const [path, value] of Object.entries(source)) {
    if (selectedScopeCanRead(scope, path)) target[path] = value
  }
}

function sourceItemWorkspacePath(
  source: ReturnType<typeof normalizeWorkspaceSources>[number],
  sourcePath: string,
): string {
  const normalized = normalizeWorkspacePath(sourcePath)
  return normalizeWorkspacePath(source.mountPath ? `${source.mountPath}/${normalized}` : normalized)
}

function selectedScopeCanRead(scope: WorkspaceSelectedScope | undefined, path: string): boolean {
  if (!scope || scope.all) return true
  const normalized = normalizeWorkspacePath(path)
  return Boolean(scope.paths?.some(prefix => pathContains(normalizeWorkspacePath(prefix), normalized)))
}

function selectedScopeCanSee(scope: WorkspaceSelectedScope | undefined, path: string): boolean {
  if (!scope || scope.all) return true
  const normalized = normalizeWorkspacePath(path)
  return Boolean(scope.paths?.some(prefix => pathIntersects(normalizeWorkspacePath(prefix), normalized)))
}

function filterScopedEntries(scope: WorkspaceSelectedScope | undefined, entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter(entry => selectedScopeCanSee(scope, entry.path))
}

function filterScopedHits(scope: WorkspaceSelectedScope | undefined, hits: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  return hits.filter(hit => selectedScopeCanRead(scope, hit.path))
}

function mergeEntries(base: WorkspaceEntry[], source: WorkspaceEntry[]): WorkspaceEntry[] {
  const entries = new Map<string, WorkspaceEntry>()
  for (const entry of base) entries.set(entry.path, entry)
  for (const entry of source) entries.set(entry.path, entry)
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function mergeHits(base: WorkspaceSearchHit[], source: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  const seen = new Set<string>()
  return [...base, ...source].filter((hit) => {
    const key = `${hit.path}:${hit.line}:${hit.column}:${hit.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function selectedScopeIntersectsSource(
  scope: WorkspaceSelectedScope | undefined,
  source: ReturnType<typeof normalizeWorkspaceSources>[number],
): boolean {
  if (!scope || scope.all) return true
  if (scope.sources?.includes(source.key)) return true
  const sourcePaths = source.requestOnly
    ? [workspaceSourceRequestDescriptorPath(source.key)]
    : source.probeKeys?.length
      ? source.probeKeys.map(key => [source.mountPath, key].filter(Boolean).join("/"))
      : [source.mountPath]
  return Boolean(scope.paths?.some(path => sourcePaths.some(sourcePath => pathIntersects(path, sourcePath))))
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function pathIntersects(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}
