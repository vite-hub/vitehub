import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"

import { check, fallback, literal, object, optional, pipe, record, safeParse, string, unknown } from "valibot"

import { copyJsonFileMetadata } from "../core/file-metadata.ts"
import { assertWorkspaceDigest, workspaceError } from "../core/errors.ts"
import { workspaceStoreTarget } from "./target.ts"
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

const fileMetadataSchema = optional(pipe(unknown(), check(value => !Array.isArray(value)), record(string(), unknown()), check(value => {
  return safeParse(optional(string()), value.source).success
})))

function assertFileMetadata(path: string, metadata: WorkspaceFile["metadata"]) {
  metadata = copyJsonFileMetadata(path, metadata)
  if (!safeParse(fileMetadataSchema, metadata).success) {
    throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. metadata.source must be a string when provided.`)
  }
  return metadata
}

async function backupFile(path: string, backup: string): Promise<number | undefined> {
  const { chmod, chown, copyFile, link, rm, stat, utimes } = await import("node:fs/promises")
  try {
    await link(path, backup)
  } catch (error) {
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(Reflect.get(Object(error), "code"))) throw error
    // Keep the public path readable until atomic replacement, even without links.
    const original = await stat(path)
    try {
      await copyFile(path, backup, constants.COPYFILE_EXCL)
      const copied = await stat(backup)
      if (process.platform !== "win32" && copied.gid !== original.gid) {
        // A group-authorized writer cannot assume another user's UID. Keep the
        // copy owned by this writer, as an ordinary replacement would be.
        await chown(backup, copied.uid, original.gid)
      }
      await chmod(backup, original.mode & (copied.uid === original.uid ? 0o7777 : 0o777))
      await utimes(backup, original.atime, original.mtime)
      if (process.platform !== "win32" && copied.uid !== original.uid) return original.uid
    } catch (error) {
      await rm(backup, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function restoreBackup(backup: string, path: string, foreignUid: number | undefined, publicationError: unknown): Promise<void> {
  if (foreignUid !== undefined) {
    // Keep the recovery copy, but never claim to restore a different owner's file.
    throw new AggregateError([publicationError], `[vitehub] Cannot roll back ${path} without changing owner UID ${foreignUid}. Recovery content remains at ${backup}.`)
  }
  const { rename } = await import("node:fs/promises")
  await rename(backup, path)
}

async function reclaimBackup(path: string, retryDelay = 1000, attempts = 0): Promise<void> {
  const { rename, rm } = await import("node:fs/promises")
  try {
    if (!path.endsWith(".committed.bak")) {
      const committed = path.replace(/\.bak$/, ".committed.bak")
      await rename(path, committed).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      path = committed
    }
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

async function reclaimCommittedBackups(root: string): Promise<void> {
  const { readdir } = await import("node:fs/promises")
  // Only the post-publication rename makes a backup eligible for a later sweep.
  // Plain .bak files may still be needed by active writers or failed rollbacks.
  const entries = await readdir(root).catch(() => [])
  await Promise.all(entries.filter(name => /^[0-9a-f-]{36}\.committed\.bak$/.test(name))
    .map(name => reclaimBackup(`${root}/${name}`)))
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

async function closeCreatedMarker(file: import("node:fs/promises").FileHandle, path: string): Promise<void> {
  try { await file.close() }
  catch (error) {
    const errors = [error]
    // A rejected close may leave the handle open, preventing unlink on Windows.
    try { await file.close() }
    catch (closeError) { errors.push(closeError) }
    const { rm } = await import("node:fs/promises")
    try { await rm(path, { force: true }) }
    catch (removeError) { errors.push(removeError) }
    if (errors.length > 1) throw new AggregateError(errors, `[vitehub] Failed to close and clean Workspace marker ${path}.`)
    throw error
  }
}

async function withFilesystemReadLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>): Promise<T> {
  const { open, rm, rmdir } = await import("node:fs/promises")
  const reader = `${lock}.readers/${randomUUID()}`
  await withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
    await ensureLockDirectory(`${lock}.readers`)
    if (process.platform !== "win32") await applyMetadataPermissions(`${lock}.readers`, permissions.mode & 0o770, permissions.gid)
    const marker = await open(reader, "wx")
    await closeCreatedMarker(marker, reader)
  })
  // Keep the reader marker open for the duration of the read so its own
  // heartbeat remains authoritative while writers inspect the reader set.
  try {
    const lease = await open(reader, "r+")
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
  #fileMetadataRoot: string
  #meta = new Map<string, unknown>()
  #metaLoaded = false
  #metaPath: string

  constructor(public root: string) {
    this.#fileMetadataRoot = `${root}/.vitehub/file-metadata`
    this.#metaPath = `${root}.meta.json`
  }

  #removalMarker(path: string) {
    return `${this.root}/.vitehub/file-removals/${createHash("sha256").update(path).digest("hex")}`
  }

  async #assertNoPendingRemoval(path: string) {
    const { lstat, stat } = await import("node:fs/promises")
    const directory = `${this.root}/.vitehub/file-removals`
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return
    assertTrustedMetadata(directory, info, await stat(this.root))
    if (!info.isDirectory()) throw workspaceError(`[vitehub] Invalid Workspace removal directory.`)
    const parts = normalizeWorkspacePath(path).split("/").filter(Boolean)
    for (let index = 0; index <= parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/")
      const pending = await lstat(this.#removalMarker(ancestor)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (pending) throw workspaceError(`[vitehub] Interrupted Workspace removal at ${ancestor || "/"}; retry removal before accessing ${path}.`)
    }
  }

  async #readFileMetadata(path: string) {
    const { lstat, open } = await import("node:fs/promises")
    await this.#assertNoPendingRemoval(path)
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
      return
    }
    let content: string
    try {
      const opened = await file.stat()
      assertTrustedMetadata(metadataPath, opened, root)
      if (!opened.isFile()) return
      // Read the opened sidecar even if another writer replaces its path.
      content = await file.readFile("utf8")
    }
    finally {
      await file.close()
    }
    let value: unknown
    try { value = JSON.parse(content) }
    catch { throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}.`) }
    const parsed = safeParse(object({
      path: literal(path),
      mediaType: fallback(optional(string()), undefined),
      metadata: fileMetadataSchema,
    }), value)
    // Invalid ownership must not turn a Source file into an ordinary writable file.
    if (!parsed.success) throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}.`)
    const { path: _path, ...result } = parsed.output
    return { ...result, metadata: assertFileMetadata(path, result.metadata) }
  }

  async #prepareMetadataDirectories(path: string, create: boolean, repair = true) {
    const { lstat, mkdir, rm, stat } = await import("node:fs/promises")
    const root = await stat(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !create) return undefined
      throw error
    })
    if (!root) return { mode: 0o600, gid: undefined, root: undefined }
    const mode = root.mode & 0o770
    let directory = this.root
    for (const part of [".vitehub", "file-metadata", ...normalizeWorkspacePath(path).split("/").filter(Boolean)]) {
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
    await this.#assertNoPendingRemoval(path)
    const { lstat, rename, rm, writeFile } = await import("node:fs/promises")
    const metadataPath = resolveInside(this.#fileMetadataRoot, `${path}/metadata.json`)
    const hasMetadata = value.mediaType !== undefined || value.metadata !== undefined
    const permissions = await this.#prepareMetadataDirectories(path, hasMetadata)
    if (!permissions.root) {
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
      metadata: copyJsonFileMetadata(normalized, metadata?.metadata),
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
    file = { ...file, metadata: assertFileMetadata(path, file.metadata) }
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm, writeFile } = await import("node:fs/promises")
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const backup = `${tempRoot}/${randomUUID()}.bak`
    await reclaimCommittedBackups(tempRoot)
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
      const foreignUid = hadExisting ? await backupFile(absolute, backup) : undefined
      await rename(temp, absolute).catch(async (error) => {
        await rm(backup, { force: true })
        throw error
      })
      try {
        await this.#writeFileMetadata(normalized, { mediaType: file.mediaType, metadata: file.metadata })
      } catch (error) {
        if (hadExisting) {
          await restoreBackup(backup, absolute, foreignUid, error)
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
    file = { ...file, metadata: assertFileMetadata(path, file.metadata) }
    const { dirname } = await import("node:path")
    const { mkdir, rename, rm } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const backup = `${tempRoot}/${randomUUID()}.bak`
    await reclaimCommittedBackups(tempRoot)
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
          metadata: copyJsonFileMetadata(normalized, file.metadata),
        })
        return {
          ...existing,
          mediaType: file.mediaType,
          metadata: copyJsonFileMetadata(normalized, file.metadata),
          size,
          digest,
        }
      }

      const hadExisting = existing?.type === "file"
      const foreignUid = hadExisting ? await backupFile(absolute, backup) : undefined
      await rename(temp, absolute).catch(async (error) => {
        await rm(backup, { force: true })
        throw error
      })
      try {
        await this.#writeFileMetadata(normalized, { mediaType: file.mediaType, metadata: file.metadata })
      } catch (error) {
        if (hadExisting) await restoreBackup(backup, absolute, foreignUid, error)
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
        metadata: copyJsonFileMetadata(normalized, file.metadata),
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
    const all = await walk(this.root, current, options.exclude, options.recursive === true, false)
    const filtered = all
      .filter((entry) => {
        if (resolve(this.root, entry.path) === resolve(this.#metaPath)) return false
        if (!normalizedPrefix) return options.recursive || !entry.path.includes("/")
        if (entry.path === normalizedPrefix) return false
        if (!entry.path.startsWith(`${normalizedPrefix}/`)) return false
        return options.recursive || !entry.path.slice(normalizedPrefix.length + 1).includes("/")
      })
    const entries: WorkspaceEntry[] = []
    // Entries under one top-level path share reader gates. Visit each group
    // sequentially, while independent groups can still read concurrently.
    const groups = new Map<string, WorkspaceEntry[]>()
    for (const entry of filtered) {
      const key = entry.path.split("/")[0]!
      const group = groups.get(key) ?? []
      group.push(entry)
      groups.set(key, group)
    }
    const independent = [...groups.values()]
    for (let index = 0; index < independent.length; index += 64) {
      await Promise.all(independent.slice(index, index + 64).map(async (group) => {
        for (const entry of group) {
          const info = await withWorkspacePathLock(this.root, entry.path, () => this.#stat(entry.path, includeDigest), true)
          if (info) entries.push(info)
        }
      }))
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
      metadata: copyJsonFileMetadata(normalized, metadata?.metadata),
    }
    if (includeDigest && info.isFile()) entry.digest = await fileDigest(absolute)
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
    const { lstat, mkdir, open, rm, rmdir } = await import("node:fs/promises")
    const normalized = normalizeWorkspacePath(path)
    const metadata = await this.#prepareMetadataDirectories(normalized, false)
    const marker = this.#removalMarker(normalized)
    let createdMarker = false
    if (metadata.root) {
      const directory = `${this.root}/.vitehub/file-removals`
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const info = await lstat(directory)
      assertTrustedMetadata(directory, info, metadata.root)
      if (!info.isDirectory()) throw workspaceError(`[vitehub] Invalid Workspace removal directory.`)
      if (process.platform !== "win32") await applyMetadataPermissions(directory, metadata.root.mode & 0o770, metadata.root.gid)
      // Keep this marker outside the sidecar subtree so interrupted recursive
      // cleanup cannot expose descendants with reusable ownership metadata.
      const file = await open(marker, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return undefined
        throw error
      })
      createdMarker = file !== undefined
      if (file) await closeCreatedMarker(file, marker)
    }
    let missingTargetError: NodeJS.ErrnoException | undefined
    await rm(resolveInside(this.root, path), {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ERR_FS_EISDIR" && !options.recursive) {
        await rmdir(resolveInside(this.root, path))
        return
      }
      throw error
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        if (!options.force) missingTargetError = error
        return
      }
      // A failed non-recursive removal deleted no descendants. Only
      // clear our own marker; an earlier interrupted removal still needs recovery.
      if (createdMarker && !options.recursive) await rm(marker, { force: true })
      throw error
    })
    const { rm: removeMetadata } = await import("node:fs/promises")
    if (metadata.root) await removeMetadata(resolveInside(this.#fileMetadataRoot, normalized), { force: true, recursive: true })
    await rm(marker, { force: true })
    if (missingTargetError) throw missingTargetError
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
    const value = this.#meta.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.#loadMeta()
    this.#meta.set(key, structuredClone(value))
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
