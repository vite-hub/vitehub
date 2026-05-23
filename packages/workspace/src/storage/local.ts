import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, matchesAny, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"

import type {
  DiffOptions,
  GlobOptions,
  ListOptions,
  MkdirOptions,
  RmOptions,
  SnapshotOptions,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceStat,
  WorkspaceStore,
} from "../core/types.ts"

async function walk(root: string, current = root): Promise<WorkspaceEntry[]> {
  const { readdir } = await import("node:fs/promises")
  const { relative } = await import("node:path")
  const entries: WorkspaceEntry[] = []
  const dirents = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  for (const dirent of dirents) {
    const absolute = `${current}/${dirent.name}`
    const path = normalizeWorkspacePath(relative(root, absolute))
    const { stat, readFile } = await import("node:fs/promises")
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (dirent.isDirectory()) {
      entries.push({ path, type: "directory", mtime: info.mtimeMs })
      entries.push(...await walk(root, absolute))
      continue
    }
    if (dirent.isFile()) {
      const bytes = await readFile(absolute)
      entries.push({
        path,
        type: "file",
        size: info.size,
        mtime: info.mtimeMs,
        digest: await sha256(bytes),
      })
    }
  }
  return entries
}

class LocalWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #files = new Map<string, Pick<WorkspaceFile, "mediaType" | "metadata">>()
  #meta = new Map<string, unknown>()
  #metaLoaded = false
  #metaPath: string

  constructor(public root: string) {
    this.#metaPath = `${root}.meta.json`
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const { readFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!bytes) return undefined
    const normalized = normalizeWorkspacePath(path)
    const metadata = this.#files.get(normalized)
    return {
      path: normalized,
      content: new Uint8Array(bytes),
      mediaType: metadata?.mediaType,
      metadata: metadata?.metadata,
    }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const { dirname } = await import("node:path")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, contentToBytes(file.content))
    this.#files.set(normalizeWorkspacePath(path), {
      mediaType: file.mediaType,
      metadata: file.metadata,
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const all = await walk(this.root)
    return all
      .filter((entry) => {
        if (!normalizedPrefix) return options.recursive || !entry.path.includes("/")
        if (entry.path === normalizedPrefix) return false
        if (!entry.path.startsWith(`${normalizedPrefix}/`)) return false
        return options.recursive || !entry.path.slice(normalizedPrefix.length + 1).includes("/")
      })
      .map(entry => ({
        ...entry,
        mediaType: entry.type === "file" ? this.#files.get(entry.path)?.mediaType : entry.mediaType,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const entries = await this.list("", { recursive: true })
    return entries.filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const { readFile, stat } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, normalized)
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return undefined
    const entry: WorkspaceStat = {
      path: normalized,
      type: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? info.size : undefined,
      mtime: info.mtimeMs,
      mediaType: info.isFile() ? this.#files.get(normalized)?.mediaType : undefined,
      digest: info.isFile() ? await sha256(await readFile(absolute)) : undefined,
    }
    return entry
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(resolveInside(this.root, path), { recursive: options.recursive ?? true })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const { rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    await rm(resolveInside(this.root, path), {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && options.force) return
      throw error
    })
    for (const key of this.#files.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/`)) this.#files.delete(key)
    }
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(this.root, { recursive: true })
    const snapshot = await this.#createSnapshot(options.name)
    this.#baseline = snapshot
    return snapshot
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline
    const to = await this.#createSnapshot()
    const entries: WorkspaceDiff["entries"] = []
    const keys = new Set([...Object.keys(from?.entries || {}), ...Object.keys(to.entries)])
    for (const path of [...keys].sort()) {
      const before = from?.entries[path]
      const after = to.entries[path]
      if (!before && after) entries.push({ path, type: "added", after })
      else if (before && !after) entries.push({ path, type: "removed", before })
      else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size)) {
        entries.push({ path, type: "modified", before, after })
      }
    }
    return { from: from?.id, to: to.id, entries }
  }

  async getMeta(key: string): Promise<unknown> {
    await this.#loadMeta()
    return this.#meta.get(key)
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.#loadMeta()
    this.#meta.set(key, value)
    await this.#writeMeta()
  }

  async #createSnapshot(name?: string): Promise<WorkspaceSnapshot> {
    const entries: WorkspaceSnapshot["entries"] = {}
    for (const entry of await this.list("", { recursive: true })) {
      entries[entry.path] = {
        type: entry.type,
        digest: entry.digest,
        size: entry.size,
      }
    }
    return {
      id: await sha256({ name, entries, createdAt: Date.now() }),
      name,
      createdAt: new Date().toISOString(),
      entries,
    }
  }

  async #loadMeta() {
    if (this.#metaLoaded) return
    this.#metaLoaded = true
    const { readFile } = await import("node:fs/promises")
    const content = await readFile(this.#metaPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!content) return
    const value = JSON.parse(content) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    this.#meta = new Map(Object.entries(value))
  }

  async #writeMeta() {
    const { dirname } = await import("node:path")
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(dirname(this.#metaPath), { recursive: true })
    await writeFile(this.#metaPath, JSON.stringify(Object.fromEntries(this.#meta), null, 2))
  }
}

export function createLocalWorkspaceStore(root: string): WorkspaceStore {
  if (!root) throw new WorkspaceError("[vitehub] Local workspace store requires a root directory.")
  return new LocalWorkspaceStore(root)
}
