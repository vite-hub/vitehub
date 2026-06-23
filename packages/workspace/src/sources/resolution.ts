import { createWorkspaceTools } from "../ai.ts"
import { normalizeWorkspacePath } from "../core/path.ts"
import { createBasicWorkspaceSession } from "../session/basic.ts"
import { createMemoryWorkspaceStore } from "../storage/memory.ts"
import { copyWorkspaceSourceMetadata, normalizeWorkspaceSource, normalizeWorkspaceSources } from "./config.ts"
import { attachWorkspaceSourceRequestExecution, createWorkspaceSourceRequestExecution } from "./request-execution.ts"
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

export function hasWorkspaceSourceResolvers(definition: Pick<WorkspaceDefinition, "sources"> | undefined): boolean {
  return normalizeWorkspaceSources(definition?.sources).some(source => typeof source.source.resolve === "function")
}

function isWritableWorkspaceFacade<Name extends WorkspaceName>(workspace: ReadonlyWorkspaceFacade<Name>): workspace is WritableWorkspaceFacade<Name> {
  return typeof (workspace as WritableWorkspaceFacade<Name>).fs.writeFile === "function"
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
): WorkspaceStore {
  const memory = createMemoryWorkspaceStore()

  async function readBaseFile(path: string): Promise<WorkspaceFile | undefined> {
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
      return await workspace.fs.list(path as never, options)
    }
    catch {
      return []
    }
  }

  async function baseGlob(pattern: string | string[], options?: GlobOptions) {
    try {
      return await workspace.fs.glob(pattern as never, options)
    }
    catch {
      return []
    }
  }

  async function baseStat(path: string) {
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

async function startOverlayWorkspaceSession(definition: WorkspaceDefinition, workspace: Workspace) {
  if (definition.runtime === "sandbox") {
    const { createSandboxWorkspaceSession } = await import("../session/sandbox.ts")
    return await createSandboxWorkspaceSession(definition, workspace)
  }
  if (definition.runtime === "trusted-host") {
    const { createTrustedHostWorkspaceSession } = await import("../session/trusted-host.ts")
    return await createTrustedHostWorkspaceSession(definition, workspace)
  }
  return createBasicWorkspaceSession(workspace)
}

export async function resolveWorkspaceSources(
  definition: WorkspaceDefinition,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceDefinition> {
  if (!hasWorkspaceSourceResolvers(definition)) return definition

  const sources: Record<string, WorkspaceSource> = {}
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
  })
  if (!options.overlay && resolvedDefinition === definition && !sourceRequestExecution) return { definition, workspace }

  const sourceView = createWorkspaceSourceView(resolvedDefinition, createOverlaySourceStore(workspace))
  const materializeSources = async (options = {}) => await sourceView.materializeSources(options)
  const fs: ReadonlyWorkspaceFacade<Name>["fs"] = attachWorkspaceSourceRequestExecution({
    async readFile(path, options) {
      if (isSourcePath(resolvedDefinition, path) || await sourceViewHasPath(resolvedDefinition, sourceView, path)) {
        return await sourceView.readFile(path, options as never)
      }
      return await workspace.fs.readFile(path, options as never)
    },
    async stat(path) {
      if (isSourcePath(resolvedDefinition, path) || await sourceViewHasPath(resolvedDefinition, sourceView, path)) {
        return await sourceView.stat(path)
      }
      return await workspace.fs.stat(path)
    },
    async exists(path) {
      if (isSourcePath(resolvedDefinition, path)) return await sourceView.exists(path)
      return await sourceViewHasPath(resolvedDefinition, sourceView, path) || await workspace.fs.exists(path)
    },
    async list(path = "", options = {}) {
      const normalized = normalizeWorkspacePath(path)
      if (normalized && isSourcePath(resolvedDefinition, normalized)) return await sourceView.list(normalized, options)
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.list(path as never, options as ListOptions),
        sourcePathIntersects(resolvedDefinition, normalized) ? sourceView.list(normalized, options) : Promise.resolve([]),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), sourceEntries)
    },
    async glob(pattern, options) {
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.glob(pattern as never, options),
        sourceView.glob(pattern as never, options),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), sourceEntries)
    },
    async search(query) {
      const scopedToSource = searchQueryTargetsSource(resolvedDefinition, query)
      const [baseHits, sourceHits] = await Promise.all([
        scopedToSource ? Promise.resolve([]) : workspace.fs.search(query),
        sourceView.search(query),
      ])
      return mergeHits(filterBaseHits(resolvedDefinition, baseHits), sourceHits).slice(0, query.limit ?? 100)
    },
    materializeSources,
  }, sourceRequestExecution)

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
  tools.inspect = createTools as unknown as WorkspaceReadToolSet["inspect"]
  tools.none = (() => ({})) as WorkspaceReadToolSet["none"]

  if (isWritableWorkspaceFacade(workspace)) {
    const writeFs: WritableWorkspaceFacade<Name>["fs"] = attachWorkspaceSourceRequestExecution({
      appendFile: async (path, content) => {
        await sourceView.assertWritable(path)
        await workspace.fs.appendFile(path, content)
      },
      copyPath: async (from, to, options) => {
        await sourceView.assertWritable(to)
        await workspace.fs.copyPath(from, to, options)
      },
      exists: fs.exists,
      glob: fs.glob,
      list: fs.list,
      mkdir: async (path, options) => {
        await sourceView.assertWritable(path)
        await workspace.fs.mkdir(path, options)
      },
      movePath: async (from, to, options) => {
        await sourceView.assertWritable(from)
        await sourceView.assertWritable(to)
        await workspace.fs.movePath(from, to, options)
      },
      readFile: fs.readFile,
      rm: async (path, options) => {
        await sourceView.assertWritable(path)
        await workspace.fs.rm(path, options)
      },
      search: fs.search,
      stat: fs.stat,
      writeFile: async (path, content, options) => {
        await sourceView.assertWritable(path)
        await workspace.fs.writeFile(path, content, options)
      },
    }, sourceRequestExecution)
    let writeWorkspace!: Workspace
    writeWorkspace = attachWorkspaceSourceRequestExecution({
      name: resolvedDefinition.name,
      diff: workspace.diff,
      exists: writeFs.exists,
      glob: writeFs.glob,
      list: writeFs.list,
      materializeSources,
      mkdir: writeFs.mkdir,
      readFile: writeFs.readFile,
      rm: writeFs.rm,
      search: writeFs.search,
      snapshot: workspace.snapshot,
      startSession: async () => await startOverlayWorkspaceSession(resolvedDefinition, writeWorkspace),
      stat: writeFs.stat,
      sync: workspace.sync,
      writeFile: writeFs.writeFile,
      mount(options) {
        const mode = options?.mode || "read-only"
        return {
          workspace: writeWorkspace,
          mode,
          target: options?.target || "/workspace",
          async diff() {
            return await writeWorkspace.diff()
          },
          async commit() {
            await writeWorkspace.snapshot({ name: "mount-commit" })
          },
          async export() {
            return await writeWorkspace.snapshot({ name: "mount-export" })
          },
        }
      },
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
    writeTools.inspect = createTools as unknown as WorkspaceWriteToolSet["inspect"]
    writeTools.none = (() => ({})) as WorkspaceWriteToolSet["none"]
    writeTools.write = createWriteTools as unknown as WorkspaceWriteToolSet["write"]
    const writableWorkspace: WritableWorkspaceFacade<Name> = {
      ...workspace,
      diff: writeWorkspace.diff,
      fs: writeFs,
      materializeSources,
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

  return {
    definition: resolvedDefinition,
    workspace: {
      fs,
      tools,
    },
  }
}

async function resolveWorkspaceSource(
  definition: WorkspaceDefinition,
  key: string,
  input: WorkspaceSourceInput,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceSource | undefined> {
  const declared = normalizeWorkspaceSource(key, input)
  const source = declared.source
  if (!source.resolve) return source

  const context: WorkspaceSourceResolutionContext<object, string> = {
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
  if (!selectedScopeIntersectsMount(options.selectedWorkspaceScope, normalized.mountPath)) return undefined

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
            }
          : undefined,
      },
    },
  })
}

function applyResolvedWorkspaceSourceBinding(input: WorkspaceSourceInput, source: WorkspaceSource): WorkspaceSource {
  if (!isPlainRecord(input) || !("source" in input)) return source
  const next: WorkspaceSource = { ...source }
  copyDefinedWorkspaceBindingOption(next, input, "cache")
  copyDefinedWorkspaceBindingOption(next, input, "instructions")
  copyDefinedWorkspaceBindingOption(next, input, "materialize")
  copyDefinedWorkspaceBindingOption(next, input, "mount")
  copyDefinedWorkspaceBindingOption(next, input, "sync")
  copyDefinedWorkspaceBindingOption(next, input, "validate")
  return next
}

function copyDefinedWorkspaceBindingOption<TKey extends "cache" | "instructions" | "materialize" | "mount" | "sync" | "validate">(
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
  return normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize !== "none")
    .some(source => pathIntersects(source.mountPath, path))
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

function selectedScopeIntersectsMount(scope: WorkspaceSelectedScope | undefined, mountPath: string): boolean {
  if (!scope || scope.all) return true
  return Boolean(scope.paths?.some(path => pathIntersects(path, mountPath)))
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function pathIntersects(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}
