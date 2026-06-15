import { defu } from "defu"

import { WorkspaceError } from "../core/errors.ts"
import { decodeFile, normalizeSafeWorkspacePath } from "../core/path.ts"

import type {
  ReadFileOptions,
  ReadFileResult,
  SourceContext,
  SourceContextWorkspaceFiles,
  WorkspaceCacheOptions,
  WorkspaceDefinition,
  WorkspaceMaterializeMode,
  WorkspaceSource,
  WorkspaceStore,
  WorkspaceValidateMode,
} from "../core/types.ts"

export interface ResolvedWorkspaceSource {
  key: string
  source: WorkspaceSource
  mountPath: string
  materialize: WorkspaceMaterializeMode
  cache: false | WorkspaceCacheOptions
  validate: WorkspaceValidateMode
  instructions?: WorkspaceSource["instructions"]
  livePaths?: Record<string, string>
  readonly: true
}

const liveSourcePaths = new WeakMap<WorkspaceSource, Record<string, string>>()

export function markLiveWorkspaceSource(source: WorkspaceSource, paths: Record<string, string>): WorkspaceSource {
  liveSourcePaths.set(source, paths)
  return source
}

export function createSourceContext(definition: WorkspaceDefinition, source?: { key: string, mountPath: string }, store?: WorkspaceStore): SourceContext {
  return {
    mountPath: source?.mountPath,
    rootDir: definition.rootDir || process.cwd(),
    source: source?.key,
    sourceRootDir: definition.sourceRootDir,
    workspace: definition.name,
    workspaceFiles: store ? createSourceContextWorkspaceFiles(store) : undefined,
  }
}

function createSourceContextWorkspaceFiles(store: WorkspaceStore): SourceContextWorkspaceFiles {
  async function readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>> {
    const workspacePath = normalizeSafeWorkspacePath(path)
    const file = await store.readFile(workspacePath)
    if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
    return decodeFile(file.content, options)
  }

  async function stat(path: string) {
    return await store.stat(normalizeSafeWorkspacePath(path, { allowEmpty: true }))
  }

  return {
    readFile,
    stat,
    async exists(path) {
      return Boolean(await stat(path))
    },
  }
}

export function normalizeWorkspaceSources(sources: WorkspaceDefinition["sources"]): ResolvedWorkspaceSource[] {
  if (!sources) return []

  return Object.entries(sources)
    .map(([key, source]) => normalizeWorkspaceSource(key, source))
    .sort((left, right) => right.mountPath.length - left.mountPath.length || left.key.localeCompare(right.key))
}

export function normalizeWorkspaceSource(key: string, source: WorkspaceSource): ResolvedWorkspaceSource {
  const mount = normalizeSourceMount(source)
  const cache = mount.cache ?? normalizeSourceCache(source) ?? false
  const mountPath = typeof mount.path === "string" ? mount.path : key
  return {
    key,
    source,
    mountPath: normalizeSafeWorkspacePath(mountPath, { allowEmpty: true }),
    materialize: mount.materialize || source.materialize || (cache ? "lazy" : "build"),
    cache,
    validate: mount.validate ?? source.validate ?? false,
    instructions: source.instructions,
    livePaths: liveSourcePaths.get(source),
    readonly: true,
  }
}

export function sourceMountContainsPath(source: Pick<ResolvedWorkspaceSource, "mountPath">, workspacePath: string): boolean {
  return workspacePath === source.mountPath || !!source.mountPath && workspacePath.startsWith(`${source.mountPath}/`)
}

export function sourceMountIntersectsPath(source: Pick<ResolvedWorkspaceSource, "mountPath">, workspacePath: string): boolean {
  return !workspacePath || !source.mountPath || sourceMountContainsPath(source, workspacePath) || source.mountPath.startsWith(`${workspacePath}/`)
}

function normalizeSourceMount(source: WorkspaceSource) {
  if (typeof source.mount === "string") {
    return { path: source.mount }
  }
  return source.mount || {}
}

function normalizeSourceCache(source: Pick<WorkspaceSource, "cache">): false | WorkspaceCacheOptions | undefined {
  if (source.cache === false) return false
  if (source.cache) return defu(source.cache, {})
}
