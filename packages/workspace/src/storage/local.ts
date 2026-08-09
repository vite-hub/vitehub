import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"

import { assertWorkspaceDigest, workspaceError } from "../core/errors.ts"
import { contentStreamChunks, contentToBytes, matchesAny, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"

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
  WorkspaceStreamFile,
  WorkspaceStore,
} from "../core/types.ts"

async function withWorkspaceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const { mkdir, open, readFile, rename, rm, stat } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const lock = `${root}.vitehub-lock`
  const owner = randomUUID()
  const ownerPath = `${lock}/owner`
  await mkdir(dirname(lock), { recursive: true })
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await mkdir(lock)
      const ownerFile = await open(ownerPath, "wx")
      await ownerFile.writeFile(owner)
      await ownerFile.close()
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const info = await stat(lock).catch(() => undefined)
      // ponytail: local locks expire after five minutes; use a provider lease if writes can legitimately run longer.
      if (info && Date.now() - info.mtimeMs > 300_000) {
        const stale = `${lock}.stale-${randomUUID()}`
        const reclaimed = await rename(lock, stale).then(() => true, (renameError: NodeJS.ErrnoException) => {
          if (renameError.code === "ENOENT") return false
          throw renameError
        })
        if (reclaimed) await rm(stale, { force: true, recursive: true })
      }
      else if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to write Workspace root: ${root}.`)
      else await delay(25)
    }
  }
  try {
    return await operation()
  }
  finally {
    const activeOwner = await readFile(ownerPath, "utf8").catch(() => undefined)
    if (activeOwner === owner) await rm(lock, { force: true, recursive: true })
  }
}

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
    const { stat } = await import("node:fs/promises")
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
      entries.push({
        path,
        type: "file",
        size: info.size,
        mtime: info.mtimeMs,
        digest: await fileDigest(absolute),
      })
    }
  }
  return entries
}

async function fileDigest(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("data", chunk => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
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
    await withWorkspaceLock(this.root, () => this.#writeFile(path, file))
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await withWorkspaceLock(this.root, async () => {
      const normalized = normalizeWorkspacePath(path)
      const current = await this.stat(normalized)
      assertWorkspaceDigest(normalized, ifDigest, current?.type === "file" ? current.digest : undefined)
      await this.#writeFile(normalized, file)
    })
  }

  async #writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const { dirname } = await import("node:path")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const normalized = normalizeWorkspacePath(path)
    const bytes = contentToBytes(file.content)
    const digest = await sha256(bytes)
    const existing = await this.stat(normalized)
    if (existing?.type === "file" && existing.digest === digest) {
      this.#files.set(normalized, {
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      return
    }
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
    this.#files.set(normalized, {
      mediaType: file.mediaType,
      metadata: file.metadata,
    })
  }

  async writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat> {
    return await withWorkspaceLock(this.root, () => this.#writeFileStream(path, file))
  }

  async #writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat> {
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, path)
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`
    const hash = createHash("sha256")
    let size = 0

    await mkdir(dirname(absolute), { recursive: true })
    try {
      const hashing = new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          hash.update(chunk)
          size += chunk.byteLength
          callback(undefined, chunk)
        },
      })
      await pipeline(
        Readable.from(contentStreamChunks(file.content)),
        hashing,
        createWriteStream(temp),
      )
      const digest = hash.digest("hex")
      const existing = await this.stat(normalized)
      if (existing?.type === "file" && existing.digest === digest) {
        await rm(temp, { force: true })
        this.#files.set(normalized, {
          mediaType: file.mediaType,
          metadata: file.metadata,
        })
        return {
          ...existing,
          mediaType: file.mediaType,
          metadata: file.metadata,
          size,
          digest,
        }
      }

      await rename(temp, absolute)
      this.#files.set(normalized, {
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      return {
        path: normalized,
        type: "file",
        size,
        mediaType: file.mediaType,
        metadata: file.metadata,
        digest,
      }
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
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
        metadata: entry.type === "file" ? this.#files.get(entry.path)?.metadata : entry.metadata,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const entries = await this.list("", { recursive: true })
    return entries.filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const { stat } = await import("node:fs/promises")
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
      metadata: info.isFile() ? this.#files.get(normalized)?.metadata : undefined,
      digest: info.isFile() ? await fileDigest(absolute) : undefined,
    }
    return entry
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(resolveInside(this.root, path), { recursive: options.recursive ?? true })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await withWorkspaceLock(this.root, () => this.#rm(path, options))
  }

  async #rm(path: string, options: RmOptions = {}): Promise<void> {
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
      else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata))) {
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
    const { mkdir, rename, rm, writeFile } = await import("node:fs/promises")
    const temp = `${this.#metaPath}.${randomUUID()}.tmp`
    await mkdir(dirname(this.#metaPath), { recursive: true })
    try {
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.#meta), null, 2))
      await rename(temp, this.#metaPath)
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export function createLocalWorkspaceStore(root: string): WorkspaceStore {
  if (!root) throw workspaceError("[vitehub] Local workspace store requires a root directory.")
  return new LocalWorkspaceStore(root)
}
