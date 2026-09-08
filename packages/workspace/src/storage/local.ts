import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"

import { check, fallback, literal, object, optional, pipe, record, safeParse, string, unknown } from "valibot"

import { assertWorkspaceDigest, workspaceError } from "../core/errors.ts"
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

async function backupFile(path: string, backup: string): Promise<boolean> {
  const { link, rename } = await import("node:fs/promises")
  try {
    await link(path, backup)
    return false
  } catch (error) {
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(Reflect.get(Object(error), "code"))) throw error
    // Preserve the original inode for rollback when hard links are unavailable.
    await rename(path, backup)
    return true
  }
}

async function reclaimBackup(path: string, retryDelay = 1000, attempts = 0): Promise<void> {
  const { rm } = await import("node:fs/promises")
  try {
    await rm(path, { force: true })
  } catch {
    if (attempts >= 5) return
    // Only committed backups enter this retry loop; active rollback files stay intact.
    // Keep retrying transient failures without keeping the process alive.
    setTimeout(() => {
      void reclaimBackup(path, Math.min(retryDelay * 2, 30_000), attempts + 1)
    }, retryDelay).unref()
  }
}

function assertTrustedMetadata(path: string, info: import("node:fs").Stats, root: import("node:fs").Stats) {
  const sharedGroup = (root.mode & 0o020) !== 0 && info.gid === root.gid
  const trustedOwner = info.uid === root.uid || info.uid === process.geteuid?.() || sharedGroup
  if (info.isSymbolicLink() || (process.platform !== "win32" && (
    !trustedOwner || (info.mode & 0o002) !== 0 || ((info.mode & 0o020) !== 0 && !sharedGroup)
  ))) throw workspaceError(`[vitehub] Untrusted Workspace metadata path: ${path}.`)
}

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

async function withFilesystemLock<T>(lock: string, description: string, operation: () => Promise<T>): Promise<T> {
  const { mkdir, open, readFile, rename, rm, stat } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
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
      if (Reflect.get(Object(error), "code") !== "EEXIST") throw error
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
      else if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to write Workspace ${description}.`)
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

async function withFilesystemReadLock<T>(lock: string, description: string, operation: () => Promise<T>): Promise<T> {
  const { mkdir, open, rm } = await import("node:fs/promises")
  const reader = `${lock}.readers/${randomUUID()}`
  await withFilesystemLock(`${lock}.gate`, description, async () => {
    await mkdir(`${lock}.readers`, { recursive: true })
    const ownerFile = await open(reader, "wx")
    await ownerFile.close()
  })
  try {
    return await operation()
  }
  finally {
    await rm(reader, { force: true })
  }
}

async function withFilesystemWriteLock<T>(lock: string, description: string, operation: () => Promise<T>): Promise<T> {
  const { readdir, rm, stat } = await import("node:fs/promises")
  return await withFilesystemLock(`${lock}.gate`, description, async () => {
    const readers = `${lock}.readers`
    const deadline = Date.now() + 10_000
    while (true) {
      const active = await readdir(readers).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (active.length === 0) return await operation()
      for (const owner of active) {
        const path = `${readers}/${owner}`
        const info = await stat(path).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > 300_000) await rm(path, { force: true })
      }
      if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to write Workspace ${description}.`)
      await delay(25)
    }
  })
}

async function withWorkspacePathLock<T>(root: string, path: string, operation: () => Promise<T>, readOnly = false): Promise<T> {
  const normalized = normalizeWorkspacePath(path)
  const parts = normalized.split("/").filter(Boolean)
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join("/"))

  const lock = async (index: number): Promise<T> => {
    if (index === paths.length) return await operation()
    const lockedPath = paths[index]!
    const key = createHash("sha256").update(lockedPath).digest("hex")
    const lockPath = `${root}.vitehub-locks/${key}`
    const next = () => lock(index + 1)
    return !readOnly && index === paths.length - 1
      ? await withFilesystemWriteLock(lockPath, `path: ${lockedPath}.`, next)
      : await withFilesystemReadLock(lockPath, `path: ${lockedPath}.`, next)
  }

  return await lock(0)
}

async function walk(
  root: string,
  current = root,
  excluded: readonly string[] = [],
  recursive = true,
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
    if (path === ".vitehub" || path.startsWith(".vitehub/")) continue
    if (isExcludedWorkspacePath(path, excluded)) continue
    const { stat } = await import("node:fs/promises")
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (dirent.isDirectory()) {
      entries.push({ path, type: "directory", mtime: info.mtimeMs })
      if (recursive) entries.push(...await walk(root, absolute, excluded, true))
      continue
    }
    if (dirent.isFile()) {
      const entry: WorkspaceEntry = {
        path,
        type: "file",
        size: info.size,
        mtime: info.mtimeMs,
      }
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
  #baseline: WorkspaceSnapshot | undefined
  #files = new Map<string, { version: string, value: Pick<WorkspaceFile, "mediaType" | "metadata"> }>()
  #fileMetadataRoot: string
  #meta = new Map<string, unknown>()
  #metaLoaded = false
  #metaPath: string

  constructor(public root: string) {
    this.#fileMetadataRoot = `${root}.vitehub-file-metadata-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
    this.#metaPath = `${root}.meta.json`
  }

  async #readFileMetadata(path: string) {
    const { lstat, open } = await import("node:fs/promises")
    const { root } = await this.#prepareMetadataDirectories(path, false, false)
    if (!root) return
    const metadataPath = resolveInside(this.#fileMetadataRoot, `${path}/metadata.json`)
    const info = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info) {
      assertTrustedMetadata(metadataPath, info, root)
      if (!info.isFile()) return
    }
    const file = await open(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!file) {
      this.#files.delete(path)
      return
    }
    let content: string
    let version: string
    try {
      const opened = await file.stat()
      assertTrustedMetadata(metadataPath, opened, root)
      if (!opened.isFile()) return
      // Read and identify the same sidecar even if another writer replaces its path.
      const info = await file.stat({ bigint: true })
      version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      const cached = this.#files.get(path)
      if (cached?.version === version) return cached.value
      content = await file.readFile("utf8")
    }
    finally {
      await file.close()
    }
    if (!content) return
    let value: unknown
    try { value = JSON.parse(content) }
    catch { throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}.`) }
    const parsed = safeParse(object({
      path: literal(path),
      mediaType: fallback(optional(string()), undefined),
      metadata: fallback(optional(pipe(unknown(), check(value => !Array.isArray(value)), record(string(), unknown()), check(value => {
        const source = value.source
        return source === undefined || safeParse(string(), source).success
      }))), undefined),
    }), value)
    if (!parsed.success) return
    const { path: _path, ...result } = parsed.output
    // Keep scans larger than the cache from evicting every reusable entry.
    if (this.#files.has(path) || this.#files.size < 1024) {
      this.#files.set(path, { version, value: result })
    }
    return result
  }

  async #prepareMetadataDirectories(path: string, create: boolean, repair = true) {
    const { lstat, mkdir, rm, stat } = await import("node:fs/promises")
    const root = await stat(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !create) return undefined
      throw error
    })
    if (!root) return { mode: 0o600, gid: undefined, root: undefined }
    const mode = root.mode & 0o770
    let directory = this.#fileMetadataRoot
    for (const part of ["", ...normalizeWorkspacePath(path).split("/").filter(Boolean)]) {
      if (part) directory = resolveInside(directory, part)
      if (create) await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !create) return undefined
        throw error
      })
      if (!info) return { mode: mode & 0o666, gid: root.gid, root: undefined }
      assertTrustedMetadata(directory, info, root)
      if (!info.isDirectory()) {
        if (repair) await rm(directory, { force: true })
        if (!create) return { mode: mode & 0o666, gid: root.gid, root: undefined }
        await mkdir(directory, { mode: 0o700 })
      }
      if (repair && process.platform !== "win32") {
        await applyMetadataPermissions(directory, mode, root.gid)
      }
    }
    return { mode: mode & 0o666, gid: root.gid, root }
  }

  async #writeFileMetadata(path: string, value: Pick<WorkspaceFile, "mediaType" | "metadata">) {
    const { lstat, rename, rm, writeFile } = await import("node:fs/promises")
    const metadataPath = resolveInside(this.#fileMetadataRoot, `${path}/metadata.json`)
    const hasMetadata = value.mediaType !== undefined || value.metadata !== undefined
    const permissions = await this.#prepareMetadataDirectories(path, hasMetadata)
    if (!permissions.root) {
      this.#files.delete(path)
      return
    }
    const existing = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing) {
      assertTrustedMetadata(metadataPath, existing, permissions.root)
      if (existing.isDirectory()) await rm(metadataPath, { recursive: true, force: true })
    }
    if (!hasMetadata) {
      await rm(metadataPath, { force: true })
      this.#files.delete(path)
      return
    }
    const temp = `${metadataPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ path, ...value }), { mode: 0o600 })
      if (process.platform !== "win32" && permissions.gid !== undefined) {
        await applyMetadataPermissions(temp, permissions.mode, permissions.gid)
      }
      await rename(temp, metadataPath)
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    this.#files.delete(path)
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
    const metadata = await this.#readFileMetadata(normalized)
    return {
      path: normalized,
      content: new Uint8Array(bytes),
      mediaType: metadata?.mediaType,
      metadata: metadata?.metadata,
    }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    await withWorkspacePathLock(this.root, path, () => this.#writeFile(path, file))
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await withWorkspacePathLock(this.root, path, async () => {
      const normalized = normalizeWorkspacePath(path)
      const current = await this.#stat(normalized)
      assertWorkspaceDigest(normalized, ifDigest, current?.type === "file" ? current.digest : undefined)
      await this.#writeFile(normalized, file)
    })
  }

  async #writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm, writeFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const backup = `${tempRoot}/${randomUUID()}.bak`
    const normalized = normalizeWorkspacePath(path)
    const bytes = contentToBytes(file.content)
    const digest = await sha256(bytes)
    const existing = await this.#stat(normalized)
    if (existing?.type === "directory") throw workspaceError(`[vitehub] Cannot write a file over directory: ${normalized}.`)
    if (existing?.type === "file" && existing.digest === digest) {
      await this.#writeFileMetadata(normalized, {
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      return
    }
    await Promise.all([
      mkdir(dirname(absolute), { recursive: true }),
      mkdir(tempRoot, { recursive: true }),
    ])
    try {
      await writeFile(temp, bytes)
      // Prefer a hard link so the live file remains readable during publication.
      const hadExisting = existing?.type === "file"
      const moved = hadExisting && await backupFile(absolute, backup)
      await rename(temp, absolute).catch(async (error) => {
        if (moved) await rename(backup, absolute)
        await rm(backup, { force: true })
        throw error
      })
      try {
        await this.#writeFileMetadata(normalized, { mediaType: file.mediaType, metadata: file.metadata })
      } catch (error) {
        if (hadExisting) {
          await rename(backup, absolute)
        }
        else await rm(absolute, { force: true })
        throw error
      }
      // Publication has committed; backup cleanup must not turn success into failure.
      await reclaimBackup(backup)
      return
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    return await withWorkspacePathLock(this.root, path, () => this.#writeFileStream(path, file))
  }

  async #writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const backup = `${tempRoot}/${randomUUID()}.bak`
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
      const existing = await this.#stat(normalized)
      if (existing?.type === "directory") throw workspaceError(`[vitehub] Cannot write a file over directory: ${normalized}.`)
      if (existing?.type === "file" && existing.digest === digest) {
        await rm(temp, { force: true })
        await this.#writeFileMetadata(normalized, {
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

      const hadExisting = existing?.type === "file"
      const moved = hadExisting && await backupFile(absolute, backup)
      await rename(temp, absolute).catch(async (error) => {
        if (moved) await rename(backup, absolute)
        await rm(backup, { force: true })
        throw error
      })
      try {
        await this.#writeFileMetadata(normalized, { mediaType: file.mediaType, metadata: file.metadata })
      } catch (error) {
        if (hadExisting) await rename(backup, absolute)
        else await rm(absolute, { force: true })
        throw error
      }
      // Publication has committed; backup cleanup must not turn success into failure.
      await reclaimBackup(backup)
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
    return await this.#list(prefix, options, false)
  }

  async #list(prefix: string, options: ListOptions, includeDigest: boolean): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const current = normalizedPrefix ? resolveInside(this.root, normalizedPrefix) : this.root
    const all = await walk(this.root, current, options.exclude, options.recursive === true)
    const filtered = all
      .filter((entry) => {
        if (!normalizedPrefix) return options.recursive || !entry.path.includes("/")
        if (entry.path === normalizedPrefix) return false
        if (!entry.path.startsWith(`${normalizedPrefix}/`)) return false
        return options.recursive || !entry.path.slice(normalizedPrefix.length + 1).includes("/")
      })
    const entries: WorkspaceEntry[] = []
    for (let index = 0; index < filtered.length; index += 64) {
      const batch = await Promise.all(filtered.slice(index, index + 64).map(entry =>
        withWorkspacePathLock(this.root, entry.path, () => this.#stat(entry.path, includeDigest), true)))
      entries.push(...batch.filter((entry): entry is WorkspaceStat => entry !== undefined))
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const entries = await this.list("", { recursive: true })
    return entries.filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    return await withWorkspacePathLock(this.root, path, () => this.#stat(path), true)
  }

  async #stat(path: string, includeDigest = true): Promise<WorkspaceStat | undefined> {
    const { stat } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, normalized)
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return undefined
    const metadata = info.isFile() ? await this.#readFileMetadata(normalized) : undefined
    const entry: WorkspaceStat = {
      path: normalized,
      type: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? info.size : undefined,
      mtime: info.mtimeMs,
      mediaType: metadata?.mediaType,
      metadata: metadata?.metadata,
    }
    if (includeDigest && info.isFile()) entry.digest = await fileDigest(absolute)
    return entry
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(resolveInside(this.root, path), { recursive: options.recursive ?? true })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await withWorkspacePathLock(this.root, path, () => this.#rm(path, options))
  }

  async #rm(path: string, options: RmOptions = {}): Promise<void> {
    const { rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const metadata = await this.#prepareMetadataDirectories(normalized, false)
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
    const { rm: removeMetadata } = await import("node:fs/promises")
    if (metadata.root) await removeMetadata(resolveInside(this.#fileMetadataRoot, normalized), { force: true, recursive: true })
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
