import { WorkspaceError } from "../errors.ts"
import { matchesAny, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../path.ts"

import type {
  GlobOptions,
  ListOptions,
  ReadFileOptions,
  ReadFileResult,
  WorkspaceAssets,
  WorkspaceContent,
  WorkspaceEntry,
  WorkspaceStat,
} from "../types.ts"

interface WorkspaceAssetFile {
  load: () => Promise<WorkspaceContent>
  mediaType?: string
}

type WorkspaceAssetFiles<TKey extends string = string> = Record<TKey, WorkspaceAssetFile>

function createMissingPathError(path: string) {
  return new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
}

function createPathMap<TKey extends string>(files: WorkspaceAssetFiles<TKey>) {
  const map = new Map<string, WorkspaceAssetFile>()

  for (const path of Object.keys(files) as TKey[]) {
    map.set(normalizeSafeWorkspacePath(path), files[path])
  }

  return map
}

function createDirectorySet(paths: string[]) {
  const directories = new Set<string>()

  for (const path of paths) {
    const segments = normalizeWorkspacePath(path).split("/").filter(Boolean)
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join("/"))
    }
  }

  return directories
}

function decodeContent<TOptions extends ReadFileOptions | undefined>(content: WorkspaceContent, options?: TOptions): ReadFileResult<TOptions> {
  if (options?.encoding === "binary") return content as ReadFileResult<TOptions>
  return (typeof content === "string" ? content : new TextDecoder().decode(content)) as ReadFileResult<TOptions>
}

function contentSize(content: WorkspaceContent) {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength
}

function normalizeAssetPath(path = "") {
  return normalizeSafeWorkspacePath(path, { allowEmpty: true })
}

function isNestedUnder(path: string, prefix: string) {
  return !prefix || path.startsWith(`${prefix}/`)
}

export function createWorkspaceAssets<TKey extends string = string>(files: WorkspaceAssetFiles<TKey>): WorkspaceAssets<TKey> {
  const pathMap = createPathMap(files)
  const paths = [...pathMap.keys()].sort()
  const directorySet = createDirectorySet(paths)
  const contentCache = new Map<string, Promise<WorkspaceContent>>()
  const statCache = new Map<string, Promise<WorkspaceStat>>()

  async function readContent(path: string) {
    const entry = pathMap.get(path)
    if (!entry) throw createMissingPathError(path)
    const cached = contentCache.get(path)
    if (cached) return await cached

    const next = entry.load()
    contentCache.set(path, next)
    return await next
  }

  async function statFile(path: string): Promise<WorkspaceStat> {
    const cached = statCache.get(path)
    if (cached) return await cached

    const entry = pathMap.get(path)
    if (!entry) throw createMissingPathError(path)

    const next = (async () => {
      const content = await readContent(path)
      return {
        digest: await sha256(content),
        mediaType: entry.mediaType,
        path,
        size: contentSize(content),
        type: "file" as const,
      }
    })()

    statCache.set(path, next)
    return await next
  }

  async function statPath(path: string): Promise<WorkspaceStat> {
    if (pathMap.has(path)) return await statFile(path)
    if (!path || directorySet.has(path)) return { path, type: "directory" }
    throw createMissingPathError(path)
  }

  function createDirectoryEntry(path: string): WorkspaceEntry {
    return { path, type: "directory" }
  }

  async function listEntries(prefix = "", options: ListOptions = {}) {
    const normalizedPrefix = normalizeAssetPath(prefix)
    const result = new Map<string, WorkspaceEntry>()

    for (const directory of directorySet) {
      if (directory === normalizedPrefix) continue
      if (normalizedPrefix && !isNestedUnder(directory, normalizedPrefix)) continue
      if (!options.recursive && normalizeWorkspacePath(directory.slice(normalizedPrefix.length)).replace(/^\//, "").includes("/")) continue
      result.set(directory, createDirectoryEntry(directory))
    }

    for (const path of paths) {
      if (path === normalizedPrefix) continue
      if (normalizedPrefix && !isNestedUnder(path, normalizedPrefix)) continue
      if (!options.recursive && normalizeWorkspacePath(path.slice(normalizedPrefix.length)).replace(/^\//, "").includes("/")) continue
      result.set(path, await statFile(path))
    }

    return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  return {
    async readFile(path, options) {
      return decodeContent(await readContent(normalizeAssetPath(path)), options)
    },
    async stat(path) {
      return await statPath(normalizeAssetPath(path))
    },
    async exists(path) {
      try {
        await statPath(normalizeAssetPath(path))
        return true
      }
      catch (error) {
        if (error instanceof WorkspaceError) return false
        throw error
      }
    },
    async list(path, options) {
      return await listEntries(path || "", options)
    },
    async glob(pattern, _options: GlobOptions = {}) {
      const entries = await listEntries("", { recursive: true })
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      return entries.filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
    },
  }
}
