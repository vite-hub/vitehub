import { assertWorkspaceDigest, workspaceError } from "../core/errors.ts"
import { normalizeWorkspacePath, matchesAny, sha256 } from "../core/path.ts"

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

type MemoryNode = {
  type: "file" | "directory"
  content?: string | Uint8Array
  mediaType?: string
  metadata?: Record<string, unknown>
  mtime: number
}

function now() {
  return Date.now()
}

class MemoryWorkspaceStore implements WorkspaceStore {
  #nodes = new Map<string, MemoryNode>([["", { type: "directory", mtime: now() }]])
  #meta = new Map<string, unknown>()
  #baseline: WorkspaceSnapshot | undefined
  #mutationQueue: Promise<void> = Promise.resolve()

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeWorkspacePath(path)
    const node = this.#nodes.get(normalized)
    if (!node || node.type !== "file") return undefined
    return {
      path: normalized,
      content: node.content || "",
      mediaType: node.mediaType,
      metadata: node.metadata,
    }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    await this.#mutate(() => this.#writeFile(path, file))
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await this.#mutate(async () => {
      const normalized = normalizeWorkspacePath(path)
      const current = this.#nodes.get(normalized)
      assertWorkspaceDigest(normalized, ifDigest, current?.type === "file" ? (await this.#entry(normalized, current)).digest : undefined)
      this.#writeFile(normalized, file)
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const result: WorkspaceEntry[] = []
    for (const [path, node] of this.#nodes) {
      if (!path || path === normalizedPrefix) continue
      if (normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) continue
      if (!options.recursive && normalizeWorkspacePath(path.slice(normalizedPrefix.length)).replace(/^\//, "").includes("/")) continue
      result.push(await this.#entry(path, node))
    }
    return result.sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const entries = await this.list("", { recursive: true })
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    return entries.filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const normalized = normalizeWorkspacePath(path)
    const node = this.#nodes.get(normalized)
    return node ? await this.#entry(normalized, node) : undefined
  }

  async mkdir(path: string, _options: MkdirOptions = {}): Promise<void> {
    await this.#mutate(() => {
      const normalized = normalizeWorkspacePath(path)
      this.#ensureParents(normalized)
      this.#nodes.set(normalized, { type: "directory", mtime: now() })
    })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await this.#mutate(() => {
      const normalized = normalizeWorkspacePath(path)
      const node = this.#nodes.get(normalized)
      if (!node) {
        if (options.force) return
        throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      }
      if (node.type === "directory" && !options.recursive) {
        for (const key of this.#nodes.keys()) {
          if (key.startsWith(`${normalized}/`)) {
            throw workspaceError(`[vitehub] Workspace directory is not empty: ${path}.`)
          }
        }
      }
      for (const key of this.#nodes.keys()) {
        if (key === normalized || key.startsWith(`${normalized}/`)) this.#nodes.delete(key)
      }
    })
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
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
      else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata))) {
        entries.push({ path, type: "modified", before, after })
      }
    }
    return { from: from?.id, to: to.id, entries }
  }

  async getMeta(key: string): Promise<unknown> {
    return this.#meta.get(key)
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.#meta.set(key, value)
  }

  #writeFile(path: string, file: WorkspaceFile): void {
    const normalized = normalizeWorkspacePath(path)
    this.#ensureParents(normalized)
    this.#nodes.set(normalized, {
      type: "file",
      content: file.content,
      mediaType: file.mediaType,
      metadata: file.metadata,
      mtime: now(),
    })
  }

  #mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation)
    this.#mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  #ensureParents(path: string) {
    const parts = normalizeWorkspacePath(path).split("/").filter(Boolean)
    for (let index = 1; index < parts.length; index++) {
      const dir = parts.slice(0, index).join("/")
      if (!this.#nodes.has(dir)) this.#nodes.set(dir, { type: "directory", mtime: now() })
    }
  }

  async #entry(path: string, node: MemoryNode): Promise<WorkspaceEntry> {
    const content = node.content || ""
    const size = node.type === "file" ? (typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength) : undefined
    return {
      path,
      type: node.type,
      size,
      mtime: node.mtime,
      mediaType: node.mediaType,
      metadata: node.metadata,
      digest: node.type === "file" ? await sha256(content) : undefined,
    }
  }

  async #createSnapshot(name?: string): Promise<WorkspaceSnapshot> {
    const entries: WorkspaceSnapshot["entries"] = {}
    for (const [path, node] of this.#nodes) {
      if (!path) continue
      const entry = await this.#entry(path, node)
      entries[path] = {
        type: entry.type,
        digest: entry.digest,
        metadata: entry.metadata,
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
}

export function createMemoryWorkspaceStore(): WorkspaceStore {
  return new MemoryWorkspaceStore()
}
