import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"

import { copyJsonFileMetadata } from "../core/file-metadata.ts"
import { assertWorkspaceDigest, workspaceError } from "../core/errors.ts"
import { workspaceStoreTarget } from "./target.ts"
import { fileAttributesUnavailable, markFileAttributesUnavailable } from "../internal/file-attributes.ts"
import { contentStreamChunks, contentToBytes, isExcludedWorkspacePath, matchesAny, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"

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

async function applyMetadataPermissions(path: string, mode: number, gid: number) {
  const { chmod, chown, stat } = await import("node:fs/promises")
  const info = await stat(path)
  if (info.gid !== gid) {
    try { await chown(path, info.uid, gid) }
    catch (error) {
      if (!["EPERM", "EACCES"].includes(Reflect.get(Object(error), "code"))) throw error
      // If the Workspace group cannot be assigned, keep metadata owner-only.
      mode &= 0o700
    }
  }
  if ((info.mode & 0o777) !== mode) {
    try { await chmod(path, mode) }
    catch (error) {
      if (!["EPERM", "EACCES"].includes(Reflect.get(Object(error), "code"))) throw error
      // Existing shared sidecars need not be owned by this writer. Keep their
      // permissions only when they already grant no more access than requested.
      if ((info.mode & 0o777 & ~mode) !== 0) throw error
    }
  }
}

async function validateLockDirectory(path: string) {
  const { lstat } = await import("node:fs/promises")
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw workspaceError(`[vitehub] Untrusted Workspace lock path: ${path}.`)
  }
}

async function ensureLockDirectory(path: string) {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await validateLockDirectory(path)
}

async function withLeaseHeartbeat<T>(file: import("node:fs/promises").FileHandle, operation: () => Promise<T>): Promise<T> {
  let renewal = Promise.resolve()
  let rejectHeartbeat!: (error: unknown) => void
  const heartbeatFailure = new Promise<never>((_, reject) => { rejectHeartbeat = reject })
  heartbeatFailure.catch(() => {})
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      const now = new Date()
      await file.utimes(now, now)
    })
    renewal.catch(rejectHeartbeat)
  }, 30_000)
  timer.unref()
  const active = Promise.resolve().then(operation)
  try {
    return await Promise.race([active, heartbeatFailure])
  }
  catch (error) {
    // A failed heartbeat cannot cancel filesystem I/O. Keep the lease until
    // the protected operation settles before its caller releases the lock.
    await active.catch(() => undefined)
    throw error
  }
  finally {
    clearInterval(timer)
    try { await renewal }
    finally { await file.close() }
  }
}

async function removeOwnedGate(lock: string) {
  const { rm } = await import("node:fs/promises")
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(lock, { force: true, recursive: true })
      return
    }
    catch (error) {
      if (attempt >= 2) throw error
      await delay(25)
    }
  }
}

async function withFilesystemLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const { mkdir, open } = await import("node:fs/promises")
  const owner = randomUUID()
  const ownerPath = `${lock}/owner`
  let lease: import("node:fs/promises").FileHandle | undefined
  const deadline = Date.now() + timeoutMs
  while (true) {
    let created = false
    try {
      await mkdir(lock, { mode: 0o700 })
      created = true
      if (process.platform !== "win32") await applyMetadataPermissions(lock, permissions.mode & 0o770, permissions.gid)
      const ownerFile = await open(ownerPath, "wx")
      try { await ownerFile.writeFile(owner) }
      catch (error) {
        await ownerFile.close()
        throw error
      }
      lease = ownerFile
      break
    }
    catch (error) {
      if (created) {
        try { await removeOwnedGate(lock) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workspace gate acquisition and cleanup failed", { cause: error }) }
        throw error
      }
      if (Reflect.get(Object(error), "code") !== "EEXIST") throw error
      await validateLockDirectory(lock)
      // Marker age cannot distinguish a crashed owner from active I/O whose
      // heartbeat failed or was delayed. Only the owner may release its gate.
      if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to write Workspace ${description}.`)
      else await delay(25)
    }
  }
  try {
    return await withLeaseHeartbeat(lease!, operation)
  }
  finally {
    // Existing gates are never reclaimed, so this invocation retains ownership
    // until release. A failed marker reread must not leave its gate behind.
    await removeOwnedGate(lock)
  }
}

async function withFilesystemReadLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>): Promise<T> {
  const { open, rm, rmdir } = await import("node:fs/promises")
  const reader = `${lock}.readers/${randomUUID()}`
  await withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
    await ensureLockDirectory(`${lock}.readers`)
    if (process.platform !== "win32") await applyMetadataPermissions(`${lock}.readers`, permissions.mode & 0o770, permissions.gid)
    await open(reader, "wx").then(file => file.close())
  })
  // Keep the reader marker open for the duration of the read so its own
  // heartbeat remains authoritative while writers inspect the reader set.
  const lease = await open(reader, "r+")
  try {
    return await withLeaseHeartbeat(lease, operation)
  }
  finally {
    await rm(reader, { force: true })
    // Cleanup must not wait behind a writer or reject an already completed read.
    // Keep registration serialized; a writer also reclaims empty reader directories.
    await withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
      await rmdir(`${lock}.readers`).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error
      })
    }, 0).catch(() => {})
  }
}

async function withFilesystemWriteLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>): Promise<T> {
  const { readdir, rmdir } = await import("node:fs/promises")
  return await withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
    const readers = `${lock}.readers`
    const deadline = Date.now() + 10_000
    while (true) {
      await validateLockDirectory(readers)
      const active = await readdir(readers).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (active.length === 0) {
        await rmdir(readers).catch(() => {})
        return await operation()
      }
      // Reader markers also remain authoritative until their owners release
      // them; a failed heartbeat must never permit a concurrent writer.
      if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to write Workspace ${description}.`)
      await delay(25)
    }
  })
}

async function withWorkspacePathLock<T>(root: string, path: string, operation: () => Promise<T>, readOnly = false): Promise<T> {
  const normalized = normalizeWorkspacePath(path)
  const parts = normalized.split("/").filter(Boolean)
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join("/"))

  const { mkdir, stat } = await import("node:fs/promises")
  if (paths.length === 0) return await operation()
  await mkdir(root, { recursive: true })
  const permissions = await stat(root)
  // Shared service accounts need access to both the persistent lock tree and
  // transient gates/readers, independently of the creating process's umask.
  for (const directory of [`${root}/.vitehub`, `${root}/.vitehub/locks`]) {
    await ensureLockDirectory(directory)
    if (process.platform !== "win32") await applyMetadataPermissions(directory, permissions.mode & 0o770, permissions.gid)
  }

  const lock = async (index: number): Promise<T> => {
    if (index === paths.length) return await operation()
    const lockedPath = paths[index]!
    const key = createHash("sha256").update(lockedPath).digest("hex")
    const lockPath = `${root}/.vitehub/locks/${key}`
    const next = () => lock(index + 1)
    return !readOnly && index === paths.length - 1
      ? await withFilesystemWriteLock(lockPath, permissions, `path: ${lockedPath}.`, next)
      : await withFilesystemReadLock(lockPath, permissions, `path: ${lockedPath}.`, next)
  }

  return await lock(0)
}

async function walk(
  root: string,
  current = root,
  excluded: readonly string[] = [],
  recursive = true,
  includeDigest = false,
): Promise<WorkspaceEntry[]> {
  const { readdir } = await import("node:fs/promises")
  const { relative } = await import("node:path")
  const entries: WorkspaceEntry[] = []
  const dirents = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  })

  for (const dirent of dirents) {
    const absolute = `${current}/${dirent.name}`
    const path = normalizeWorkspacePath(relative(root, absolute))
    const first = path.split("/")[0]
    if (first?.toLowerCase() === ".vitehub") continue
    if (isExcludedWorkspacePath(path, excluded)) continue
    const { stat } = await import("node:fs/promises")
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (dirent.isDirectory()) {
      entries.push({ path, type: "directory", mtime: info.mtimeMs })
      if (recursive) entries.push(...await walk(root, absolute, excluded, true, includeDigest))
      continue
    }
    if (dirent.isFile()) {
      const entry: WorkspaceEntry = {
        path,
        type: "file",
        size: info.size,
        mtime: info.mtimeMs,
      }
      if (includeDigest) entry.digest = await fileDigest(absolute)
      entries.push(entry)
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
  [workspaceStoreTarget]() {
    return { provider: "local" as const }
  }
  #baseline: WorkspaceSnapshot | undefined
  #files = new Map<string, Pick<WorkspaceFile, "mediaType" | "metadata">>()
  #meta = new Map<string, unknown>()
  #metaLoaded = false
  #metaPath: string

  constructor(public root: string) {
    this.#metaPath = `${root}.meta.json`
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    return await withWorkspacePathLock(this.root, path, () => this.#readFile(path), true)
  }

  async #readFile(path: string): Promise<WorkspaceFile | undefined> {
    const { readFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!bytes) return undefined
    const normalized = normalizeWorkspacePath(path)
    const metadata = this.#files.get(normalized)
    const file: WorkspaceFile = {
      path: normalized,
      content: new Uint8Array(bytes),
      mediaType: metadata?.mediaType,
      metadata: metadata?.metadata,
    }
    return metadata ? file : markFileAttributesUnavailable(file)
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    await withWorkspacePathLock(this.root, path, () => this.#writeFile(path, file))
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await withWorkspacePathLock(this.root, path, async () => {
      const normalized = normalizeWorkspacePath(path)
      const current = await this.stat(normalized)
      assertWorkspaceDigest(normalized, ifDigest, current?.type === "file" ? current.digest : undefined)
      await this.#writeFile(normalized, file)
    })
  }

  #recordFileAttributes(path: string, file: WorkspaceFile, metadata: WorkspaceFile["metadata"]): void {
    // Restoring a file read after restart must retain its unavailable attributes.
    if (fileAttributesUnavailable(file)) this.#files.delete(path)
    else this.#files.set(path, { mediaType: file.mediaType, metadata })
  }

  async #writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const metadata = copyJsonFileMetadata(path, file.metadata)
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm, writeFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const normalized = normalizeWorkspacePath(path)
    const bytes = contentToBytes(file.content)
    const digest = await sha256(bytes)
    const existing = await this.stat(normalized)
    if (existing?.type === "file" && existing.digest === digest) {
      this.#recordFileAttributes(normalized, file, metadata)
      return
    }
    await Promise.all([
      mkdir(dirname(absolute), { recursive: true }),
      mkdir(tempRoot, { recursive: true }),
    ])
    try {
      await writeFile(temp, bytes)
      await rename(temp, absolute)
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    this.#recordFileAttributes(normalized, file, metadata)
  }

  async writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    return await withWorkspacePathLock(this.root, path, () => this.#writeFileStream(path, file))
  }

  async #writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    const metadata = copyJsonFileMetadata(path, file.metadata)
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const hash = createHash("sha256")
    let size = 0

    await Promise.all([
      mkdir(dirname(absolute), { recursive: true }),
      mkdir(tempRoot, { recursive: true }),
    ])
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
          metadata,
        })
        return {
          ...existing,
          mediaType: file.mediaType,
          metadata,
          size,
          digest,
        }
      }

      await rename(temp, absolute)
      this.#files.set(normalized, {
        mediaType: file.mediaType,
        metadata,
      })
      return {
        path: normalized,
        type: "file",
        size,
        mediaType: file.mediaType,
        metadata,
        digest,
      }
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    return await this.#list(prefix, options, false)
  }

  async #list(prefix: string, options: ListOptions, includeDigest: boolean): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const current = normalizedPrefix ? resolveInside(this.root, normalizedPrefix) : this.root
    const all = await walk(this.root, current, options.exclude, options.recursive === true, includeDigest)
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
    const { mkdir, stat } = await import("node:fs/promises")
    if (!options.onCreate) {
      await mkdir(resolveInside(this.root, path), { recursive: options.recursive ?? true })
      return
    }
    const normalized = normalizeWorkspacePath(path)
    const parts = normalized.split("/").filter(Boolean)
    const directories = options.recursive === false ? [normalized] : parts.map((_, index) => parts.slice(0, index + 1).join("/"))
    await mkdir(this.root, { recursive: true })
    for (const directory of directories) {
      const absolute = resolveInside(this.root, directory)
      try {
        await mkdir(absolute)
      }
      catch (error) {
        if (Reflect.get(Object(error), "code") !== "EEXIST" || !(await stat(absolute)).isDirectory()) throw error
        continue
      }
      options.onCreate(directory)
    }
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await withWorkspacePathLock(this.root, path, () => this.#rm(path, options))
  }

  async #rm(path: string, options: RmOptions = {}): Promise<void> {
    const { rm, rmdir } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    await rm(resolveInside(this.root, path), {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    }).catch(async (error: NodeJS.ErrnoException) => {
      // Node's rm rejects even empty directories without recursive mode.
      // rmdir preserves the Store's non-recursive, empty-directory contract.
      if (error.code === "ERR_FS_EISDIR" && !options.recursive) {
        await rmdir(resolveInside(this.root, path))
        return
      }
      throw error
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
    for (const entry of await this.#list("", { recursive: true }, true)) {
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
    const value: unknown = JSON.parse(content)
    if (!value || Object(value) !== value || Array.isArray(value)) return
    this.#meta = new Map(Object.entries(Object(value)))
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
