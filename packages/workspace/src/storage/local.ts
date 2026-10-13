import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { chmod, chown, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises"
import { Readable, Transform } from "node:stream"
import { join, relative, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"

import { check, fallback, literal, object, optional, pipe, record, safeParse, string, unknown } from "valibot"

import { assertWorkspaceDigest, workspaceConflictError, workspaceError } from "../core/errors.ts"
import { copyJsonFileMetadata } from "../core/file-metadata.ts"
import { createWorkspaceGlobMatcher } from "../core/glob.ts"
import { contentStreamChunks, contentToBytes, isExcludedWorkspacePath, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"
import { workspaceStoreTarget } from "./target.ts"

import type {
  DiffOptions,
  GlobOptions,
  ListOptions,
  LocalWorkspaceStoreOptions,
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
  await rename(backup, path)
}

async function reclaimBackup(path: string, retryDelay = 1000, attempts = 0): Promise<void> {
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
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw workspaceError(`[vitehub] Untrusted Workspace lock path: ${path}.`)
  }
}

async function ensureLockDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await validateLockDirectory(path)
}

async function withLeaseHeartbeat<T>(file: import("node:fs/promises").FileHandle, operation: () => Promise<T>, onFailure?: (error: unknown) => void): Promise<T> {
  let renewal = Promise.resolve()
  let rejectHeartbeat!: (error: unknown) => void
  const heartbeatFailure = new Promise<never>((_, reject) => { rejectHeartbeat = reject })
  heartbeatFailure.catch(() => {})
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      const now = new Date()
      await file.utimes(now, now)
    })
    renewal.catch(error => {
      rejectHeartbeat(error)
      onFailure?.(error)
    })
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

async function withFilesystemLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>, deadline?: () => number): Promise<T> {
  const expiresAt = Date.now() + 10_000
  const owner = randomUUID()
  const ownerPath = `${lock}/owner`
  let lease: import("node:fs/promises").FileHandle | undefined
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
      if (Date.now() >= (deadline?.() ?? expiresAt)) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
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

async function withFilesystemReadLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>, onFailure?: (error: unknown) => void): Promise<T> {
  const reader = `${lock}.readers/${randomUUID()}`
  // The admission batch already owns the gate during reader registration.
  await ensureLockDirectory(`${lock}.readers`)
  if (process.platform !== "win32") await applyMetadataPermissions(`${lock}.readers`, permissions.mode & 0o770, permissions.gid)
  const lease = await open(reader, "wx")
  try {
    return await withLeaseHeartbeat(lease, operation, onFailure)
  }
  finally {
    await rm(reader, { force: true })
    // Cleanup must not wait behind a writer or reject an already completed read.
    // Keep registration serialized; a writer also reclaims empty reader directories.
    await withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
      await rmdir(`${lock}.readers`).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error
      })
    }, () => Date.now()).catch(() => {})
  }
}

async function withFilesystemWriteLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>): Promise<T> {
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
      if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
      await delay(25)
    }
  })
}

async function withFilesystemWriterIntent<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, operation: () => Promise<T>): Promise<T> {
  // Publish intent before competing for the gate. Readers that observe this
  // marker wait, so a writer cannot lose every gate race to new admissions.
  const intents = `${lock}.writers`
  const intent = `${intents}/${randomUUID()}`
  // The last writer can remove the empty parent during permission setup or
  // child creation. Retry the full sequence to revalidate the new parent.
  for (;;) {
    try {
      await ensureLockDirectory(intents)
      if (process.platform !== "win32") await applyMetadataPermissions(intents, permissions.mode & 0o770, permissions.gid)
      await mkdir(intent, { mode: 0o700 })
      break
    }
    catch (error) {
      if (Reflect.get(Object(error), "code") !== "ENOENT") {
        // A failed setup can leave an empty parent that readers interpret as
        // writer intent. Remove only an empty directory and retain the error.
        await rmdir(intents).catch(() => {})
        throw error
      }
    }
  }
  try {
    return await operation()
  }
  finally {
    await rm(intent, { recursive: true, force: true })
    await rmdir(intents).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error
    })
  }
}

interface SharedReadLease {
  acquired: Promise<void>
  failure?: { error: unknown }
  readers: number
  release: () => void
  settled: Promise<void>
}

// Parallel reads below one directory all need a read lock on that directory.
// One filesystem reader marker per path and process keeps them from polling
// the same gate until one of them times out.
const sharedReadLeases = new Map<string, SharedReadLease>()
// New readers wait in memory while a writer in this process is pending. The
// writer then waits only for active readers and does not compete with new
// readers for the gate. Locked operations never call locked store methods, so
// this wait cannot include the writer's own operation.
const pendingWriters = new Map<string, { count: number, idle: Promise<void>, resolve: () => void }>()

async function openSharedReadLease(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string): Promise<SharedReadLease> {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let settled!: Promise<void>
  const acquired = new Promise<void>((resolve, reject) => {
    settled = withFilesystemReadLock(lock, permissions, description, async () => {
      resolve()
      await released
    }, error => { lease.failure = { error } })
    settled.catch(reject)
  })
  const lease: SharedReadLease = { acquired, readers: 0, release, settled }
  settled.catch(() => {
    if (sharedReadLeases.get(lock) === lease) sharedReadLeases.delete(lock)
  })
  await acquired
  return lease
}

// Readers that arrive together share one gate acquisition. The gate protects
// the count update as well as the filesystem registration from external writers.
interface ReadAdmissionTicket {
  deadline: number
  charged: boolean
}

const readAdmissions = new Map<string, { tickets: Set<ReadAdmissionTicket>, admitted: Promise<SharedReadLease | undefined> }>()

async function admitSharedReader(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, deadline: number): Promise<SharedReadLease | undefined> {
  const ticket: ReadAdmissionTicket = { deadline, charged: false }
  let admission = readAdmissions.get(lock)
  if (!admission) {
    admission = { tickets: new Set(), admitted: Promise.resolve(undefined) }
    const batch = admission
    readAdmissions.set(lock, batch)
    let chargedLease: SharedReadLease | undefined
    let chargedCount = 0
    const liveTickets = () => [...batch.tickets].filter(reader => Date.now() < reader.deadline)
    batch.admitted = withFilesystemLock(`${lock}.gate`, permissions, description, async () => {
      readAdmissions.delete(lock)
      if (!liveTickets().length) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
      if (pendingWriters.has(lock) || await lstat(`${lock}.writers`).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })) return undefined
      let lease = sharedReadLeases.get(lock)
      if (!lease) {
        lease = await openSharedReadLease(lock, permissions, description)
        sharedReadLeases.set(lock, lease)
      }
      const tickets = liveTickets()
      chargedCount = tickets.length
      if (!chargedCount) {
        await releaseSharedReaders(lock, lease, 0)
        throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
      }
      lease.readers += chargedCount
      chargedLease = lease
      for (const reader of tickets) reader.charged = true
      return lease
    }, () => Math.max(...[...batch.tickets].map(reader => reader.deadline))).catch(async (error: unknown) => {
      if (chargedLease) {
        try { await releaseSharedReaders(lock, chargedLease, chargedCount) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workspace reader admission and cleanup failed", { cause: error }) }
      }
      throw error
    }).finally(() => {
      if (readAdmissions.get(lock) === batch) readAdmissions.delete(lock)
    })
  }
  // The gate acquisition lasts for the remaining callers. Each expired caller
  // detaches without reducing another caller's own admission budget.
  admission.tickets.add(ticket)
  const batch = admission
  let timedOut = false
  let timeout!: ReturnType<typeof setInterval>
  const expired = new Promise<never>((_, reject) => {
    timeout = setInterval(() => {
      if (Date.now() < deadline) return
      timedOut = true
      batch.tickets.delete(ticket)
      reject(workspaceError(`[vitehub] Timed out waiting to ${description}.`))
    }, 25)
  })
  try {
    const lease = await Promise.race([batch.admitted, expired])
    if (lease && !ticket.charged) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
    return lease
  }
  catch (error) {
    if (timedOut && ticket.charged) {
      try { await batch.admitted.then(lease => lease ? releaseSharedReaders(lock, lease) : undefined, () => undefined) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workspace reader timeout and cleanup failed", { cause: error }) }
    }
    throw error
  }
  finally {
    clearInterval(timeout)
    batch.tickets.delete(ticket)
  }
}

async function releaseSharedReaders(lock: string, lease: SharedReadLease, count = 1): Promise<void> {
  lease.readers -= count
  if (lease.readers === 0) {
    if (sharedReadLeases.get(lock) === lease) sharedReadLeases.delete(lock)
    lease.release()
    // The last reader reports a failed release, as an unshared reader does.
    await lease.settled
  }
  // Every affected reader reports the shared heartbeat failure, after its
  // protected operation finishes and its registration has been released.
  if (lease.failure) throw lease.failure.error
}

async function withSharedFilesystemReadLock<T>(lock: string, permissions: Pick<import("node:fs").Stats, "mode" | "gid">, description: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000
  let lease: SharedReadLease | undefined
  while (!lease) {
    for (let writers = pendingWriters.get(lock); writers; writers = pendingWriters.get(lock)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(workspaceError(`[vitehub] Timed out waiting to ${description}.`)), remaining)
        void writers.idle.then(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    // A writer in another process holds the gate while existing readers drain.
    // Do not extend their shared lease while that writer is waiting.
    const writerIntent = await lstat(`${lock}.writers`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const gate = await lstat(`${lock}.gate`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!writerIntent && !gate && !pendingWriters.has(lock)) {
      lease = await admitSharedReader(lock, permissions, description, deadline)
      if (lease) break
    }
    if (writerIntent) await validateLockDirectory(`${lock}.writers`)
    if (gate) await validateLockDirectory(`${lock}.gate`)
    if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
    await delay(25)
  }
  try {
    await lease.acquired
    if (Date.now() >= deadline) throw workspaceError(`[vitehub] Timed out waiting to ${description}.`)
    if (lease.failure) throw lease.failure.error
    return await operation()
  }
  finally {
    await releaseSharedReaders(lock, lease)
  }
}

async function withPendingWriter<T>(lock: string, operation: () => Promise<T>): Promise<T> {
  let writers = pendingWriters.get(lock)
  if (!writers) {
    let resolve!: () => void
    const idle = new Promise<void>((done) => { resolve = done })
    writers = { count: 0, idle, resolve }
    pendingWriters.set(lock, writers)
  }
  writers.count++
  try {
    return await operation()
  }
  finally {
    if (--writers.count === 0) {
      pendingWriters.delete(lock)
      writers.resolve()
    }
  }
}

async function withWorkspacePathLock<T>(root: string, path: string, operation: () => Promise<T>, readOnly = false, heldReadPrefix?: string): Promise<T> {
  const normalized = normalizeWorkspacePath(path)
  const parts = normalized.split("/").filter(Boolean)
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join("/"))

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
    // A listing batch already holds these ancestors in this lexical scope.
    // Descendants still need their own leases to exclude same-path writers.
    if (readOnly && heldReadPrefix && (heldReadPrefix === lockedPath || heldReadPrefix.startsWith(`${lockedPath}/`))) return await lock(index + 1)
    const key = createHash("sha256").update(lockedPath).digest("hex")
    const lockPath = `${root}/.vitehub/locks/${key}`
    const next = () => lock(index + 1)
    const description = `${readOnly ? "read" : "write"} Workspace path: ${lockedPath}`
    return !readOnly && index === paths.length - 1
      ? await withPendingWriter(lockPath, () => withFilesystemWriterIntent(lockPath, permissions, () => withFilesystemWriteLock(lockPath, permissions, description, next)))
      : await withSharedFilesystemReadLock(lockPath, permissions, description, next)
  }

  return await lock(0)
}

type LocalWorkspaceStoreLockOptions = Pick<LocalWorkspaceStoreOptions, "ignore" | "locks">

function isGitMetadataName(name: string): boolean {
  return name === ".git" || (process.platform === "win32" && name.toLowerCase() === ".git")
}

/** Check whether a path belongs to a Git worktree before classifying Git errors. */
async function hasGitMetadata(root: string): Promise<boolean> {
  let current = resolve(root)
  while (true) {
    const metadata = await lstat(join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (metadata) return true
    const parent = resolve(current, "..")
    if (parent === current) return false
    current = parent
  }
}

/** Paths that Git ignores under a checkout root. Ignored directories are listed once, not descended. */
async function gitIgnoredWorkspacePaths(root: string): Promise<string[]> {
  const { execFile } = await import("node:child_process")
  const gitMetadata = await hasGitMetadata(root)
  const output = await new Promise<string>((resolveOutput, reject) => execFile(
    "git",
    ["-C", root, "-c", "core.hooksPath=/dev/null", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      // `ignore: "git"` is also valid for ordinary directories. Treat a
      // non-repository root as having no Git exclusions, while preserving
      // failures from an unavailable or unreadable Git checkout.
      if (error) {
        const code = Reflect.get(Object(error), "code")
        if (code === 128 && /not a git repository/i.test(stderr) && !gitMetadata) {
          resolveOutput("")
          return
        }
        reject(error)
        return
      }
      resolveOutput(stdout)
    },
  ))
  return [".git", ...output.split("\0").filter(Boolean).map(path => path.replace(/\/$/, ""))]
}

/** Include ignore rules from Git roots that contain a non-root listing prefix. */
async function gitIgnoredWorkspacePathsForPrefix(root: string, current: string, excluded: readonly string[]): Promise<string[]> {
  const { relative, sep } = await import("node:path")
  const relativePrefix = relative(root, current)
  if (!relativePrefix || relativePrefix === "." || relativePrefix.startsWith(`..${sep}`)) return [...excluded]
  const result = [...excluded]
  let ancestor = root
  let prefix = ""
  for (const segment of relativePrefix.split(sep)) {
    ancestor = `${ancestor}/${segment}`
    prefix = prefix ? `${prefix}/${segment}` : segment
    const dirents = await readdir(ancestor, { withFileTypes: true }).catch(() => [])
    if (dirents.some(dirent => isGitMetadataName(dirent.name))) {
      const nestedExcluded = await gitIgnoredWorkspacePaths(ancestor)
      result.push(...nestedExcluded.map(path => `${prefix}/${path}`))
    }
  }
  return result
}

interface ProcessPathLockState {
  pendingWriters: number
  readers: number
  writer: boolean
  waiters: Array<() => void>
}

const processPathLocks = new Map<string, ProcessPathLockState>()
const processMetadataRoots = new Map<string, Promise<void>>()

async function withProcessLock<T>(key: string, exclusive: boolean, operation: () => Promise<T>): Promise<T> {
  let state = processPathLocks.get(key)
  if (!state) processPathLocks.set(key, state = { pendingWriters: 0, readers: 0, writer: false, waiters: [] })
  const current = state
  // Waiting writers block new readers, as pending writer intents do in filesystem mode.
  if (exclusive) current.pendingWriters++
  try {
    while (current.writer || (exclusive ? current.readers > 0 : current.pendingWriters > 0)) {
      await new Promise<void>(resolve => current.waiters.push(resolve))
    }
  }
  finally {
    if (exclusive) current.pendingWriters--
  }
  if (exclusive) current.writer = true
  else current.readers++
  try {
    return await operation()
  }
  finally {
    if (exclusive) current.writer = false
    else current.readers--
    const waiters = current.waiters.splice(0)
    if (!current.writer && current.readers === 0 && current.pendingWriters === 0 && waiters.length === 0) processPathLocks.delete(key)
    for (const resolve of waiters) resolve()
  }
}

async function prepareProcessMetadataRoot(root: string): Promise<void> {
  const { lstat, mkdir, stat } = await import("node:fs/promises")
  const previous = processMetadataRoots.get(root)
  if (previous) {
    // A reused root, such as a reset checkout, can lose .vitehub between stores.
    // Prepare it again when it is missing.
    const ready = await previous.then(() => lstat(`${root}/.vitehub`).then(() => true, () => false), () => false)
    if (ready) return
    if (processMetadataRoots.get(root) === previous) processMetadataRoots.delete(root)
  }
  let prepared = processMetadataRoots.get(root)
  if (!prepared) {
    prepared = (async () => {
      await mkdir(root, { recursive: true })
      const permissions = await stat(root)
      await ensureLockDirectory(`${root}/.vitehub`)
      if (process.platform !== "win32") await applyMetadataPermissions(`${root}/.vitehub`, permissions.mode & 0o770, permissions.gid)
    })()
    processMetadataRoots.set(root, prepared)
    const current = prepared
    current.catch(() => {
      if (processMetadataRoots.get(root) === current) processMetadataRoots.delete(root)
    })
  }
  await prepared
}

/**
 * Keeps the lock order of withWorkspacePathLock in memory: shared reads on
 * each parent path and an exclusive lock on the target path for a write. Use
 * it only for a store root that one process owns.
 */
async function withProcessPathLock<T>(root: string, path: string, operation: () => Promise<T>, readOnly = false): Promise<T> {
  const parts = normalizeWorkspacePath(path).split("/").filter(Boolean)
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join("/"))
  if (paths.length === 0) return await operation()
  const key = resolve(root)
  // Metadata directories keep the root permissions, as in filesystem lock mode.
  await prepareProcessMetadataRoot(key)
  const lock = async (index: number): Promise<T> => {
    if (index === paths.length) return await operation()
    return await withProcessLock(`${key}\0${paths[index]}`, !readOnly && index === paths.length - 1, () => lock(index + 1))
  }
  return await lock(0)
}

async function walk(
  root: string,
  current: string,
  privatePaths: readonly string[],
  excluded: readonly string[] = [],
  recursive = true,
): Promise<WorkspaceEntry[]> {
  const { isAbsolute, relative, sep } = await import("node:path")
  if (privatePaths.some((path) => {
    const relativePath = relative(path, current)
    return !relativePath || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  })) return []
  const entries: WorkspaceEntry[] = []
  const dirents = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  })
  let currentExcluded = excluded
  // The outer repository's Git query does not apply ignore rules from a
  // nested repository. Discover those rules before descending into it so
  // ignored dependencies and build output remain hidden at every boundary.
  if (current !== root && dirents.some(dirent => isGitMetadataName(dirent.name))) {
    const nestedExcluded = await gitIgnoredWorkspacePaths(current)
    const prefix = normalizeWorkspacePath(relative(root, current))
    currentExcluded = [...excluded, ...nestedExcluded.map(path => prefix ? `${prefix}/${path}` : path)]
  }

  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    const absolute = `${current}/${dirent.name}`
    if (privatePaths.some(path => !relative(path, absolute))) continue
    const path = normalizeWorkspacePath(relative(root, absolute))
    if (path.split("/")[0]?.toLowerCase() === ".vitehub") continue
    // Git metadata is private at every depth, including nested repositories.
    // `git ls-files --ignored` only reports ignored paths, so nested `.git`
    // directories need an explicit traversal guard.
    if (path.split("/").some(component => isGitMetadataName(component))) continue
    if (isExcludedWorkspacePath(path, currentExcluded)) continue
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (dirent.isDirectory()) {
      entries.push({ path, type: "directory", mtime: info.mtimeMs })
      if (recursive) entries.push(...await walk(root, absolute, privatePaths, currentExcluded, true))
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
  [workspaceStoreTarget]() {
    return { provider: "local" }
  }

  #baseline: WorkspaceSnapshot | undefined
  #files = new Map<string, { version: string, value: Pick<WorkspaceFile, "mediaType" | "metadata"> }>()
  #metaCache: { ino: number, mtimeMs: number, size: number, value: Map<string, unknown> } | undefined
  #fileMetadataRoot: string
  #metaPath: string
  #ignoreGit: boolean
  #processLocks: boolean

  constructor(public root: string, options: LocalWorkspaceStoreLockOptions = {}) {
    this.#ignoreGit = options.ignore === "git"
    this.#processLocks = options.locks === "process"
    this.#fileMetadataRoot = `${root}/.vitehub/file-metadata`
    this.#metaPath = `${root}.meta.json`
  }

  async #pathLock<T>(root: string, path: string, operation: () => Promise<T>, readOnly = false): Promise<T> {
    return this.#processLocks
      ? await withProcessPathLock(root, path, operation, readOnly)
      : await withWorkspacePathLock(root, path, operation, readOnly)
  }

  #removalMarker(path: string) {
    return `${this.root}/.vitehub/file-removals/${createHash("sha256").update(path).digest("hex")}`
  }

  async #assertNoPendingRemoval(path: string) {
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
      this.#files.delete(path)
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
    return await this.#pathLock(this.root, path, () => this.#readFile(path), true)
  }

  async #readFile(path: string): Promise<WorkspaceFile | undefined> {
    const absolute = resolveInside(this.root, path)
    await this.#assertPathComponents(path)
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
    await this.#pathLock(this.root, path, () => this.#writeFile(path, file))
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await this.#pathLock(this.root, path, async () => {
      const normalized = normalizeWorkspacePath(path)
      const current = await this.#stat(normalized)
      assertWorkspaceDigest(normalized, ifDigest, current?.type === "file" ? current.digest : undefined)
      await this.#writeFile(normalized, file)
    })
  }

  async #writeFile(path: string, file: WorkspaceFile): Promise<void> {
    file = { ...file, metadata: assertFileMetadata(path, file.metadata) }
    const { dirname } = await import("node:path")
    const absolute = resolveInside(this.root, path)
    const tempRoot = `${this.root}/.vitehub/tmp`
    const temp = `${tempRoot}/${randomUUID()}.tmp`
    const backup = `${tempRoot}/${randomUUID()}.bak`
    await reclaimCommittedBackups(tempRoot)
    const normalized = normalizeWorkspacePath(path)
    await this.#assertPathComponents(normalized)
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

  async #assertPathComponents(path: string, includeTarget = true): Promise<void> {
    const root = resolve(this.root)
    const parts = relative(root, resolveInside(root, path)).split(sep).filter(Boolean)
    if (!includeTarget) parts.pop()
    let current = root
    // Check from the root so inspecting a child never follows an unchecked link.
    // The configured root is trusted; concurrent external writers need OS isolation.
    for (const part of parts) {
      current = join(current, part)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!info) return
      if (info.isSymbolicLink()) throw workspaceError(`[vitehub] Refusing to access symbolic-link Workspace path: ${path}.`)
    }
  }

  async writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    return await this.#pathLock(this.root, path, () => this.#writeFileStream(path, file))
  }

  async #writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat & { digest: string }> {
    await this.#assertPathComponents(path)
    file = { ...file, metadata: assertFileMetadata(path, file.metadata) }
    const { dirname } = await import("node:path")
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
    await this.#assertPathComponents(prefix)
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const current = normalizedPrefix ? resolveInside(this.root, normalizedPrefix) : this.root
    const privatePaths = [this.#fileMetadataRoot, this.#metaPath]
    // ignore: "git" hides .git and Git-ignored output such as dependencies from listings and snapshots.
    let excluded = this.#ignoreGit ? [...options.exclude ?? [], ...await gitIgnoredWorkspacePaths(this.root)] : options.exclude
    if (this.#ignoreGit) excluded = await gitIgnoredWorkspacePathsForPrefix(this.root, current, excluded ?? [])
    const all = await walk(this.root, current, privatePaths, excluded, options.recursive === true)
    const filtered = all
      .filter((entry) => {
        if (!normalizedPrefix) return options.recursive || !entry.path.includes("/")
        if (entry.path === normalizedPrefix) return false
        if (!entry.path.startsWith(`${normalizedPrefix}/`)) return false
        return options.recursive || !entry.path.slice(normalizedPrefix.length + 1).includes("/")
      })
    const entries: WorkspaceEntry[] = []
    // Keep common ancestors leased for short batches. Yield between entries
    // before accumulated reads consume a queued writer's ten-second deadline.
    // Individual entries retain their own leases until their I/O settles.
    const readBatchDurationMs = 1_000
    const groups = new Map<string, WorkspaceEntry[]>()
    for (const entry of filtered) {
      const key = entry.path.split("/")[0]!
      const group = groups.get(key) ?? []
      group.push(entry)
      groups.set(key, group)
    }
    // Process locks share parent reads in memory, so entries of one folder do not contend.
    const independent = this.#processLocks ? filtered.map(entry => [entry]) : [...groups.values()]
    for (let index = 0; index < independent.length; index += 64) {
      await Promise.all(independent.slice(index, index + 64).map(async (group) => {
        if (this.#processLocks) {
          for (const entry of group) {
            const info = await this.#pathLock(this.root, entry.path, () => this.#stat(entry.path, includeDigest), true)
            if (info) entries.push(info)
          }
          return
        }
        const heldReadPrefix = normalizedPrefix || group[0]!.path.split("/")[0]!
        let offset = 0
        while (offset < group.length) {
          await withWorkspacePathLock(this.root, heldReadPrefix, async () => {
            const startedAt = Date.now()
            do {
              const entry = group[offset++]!
              const info = await withWorkspacePathLock(this.root, entry.path, () => this.#stat(entry.path, includeDigest), true, heldReadPrefix)
              if (info) entries.push(info)
            } while (offset < group.length && Date.now() - startedAt < readBatchDurationMs)
          }, true)
        }
      }))
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const { cwd, matches } = createWorkspaceGlobMatcher(pattern, options)
    const entries = await this.list(cwd, { recursive: true })
    return entries.filter(entry => entry.type === "file" && matches(entry.path))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    return await this.#pathLock(this.root, path, () => this.#stat(path), true)
  }

  async #stat(path: string, includeDigest = true): Promise<WorkspaceStat | undefined> {
    const normalized = normalizeWorkspacePath(path)
    const absolute = resolveInside(this.root, normalized)
    await this.#assertPathComponents(normalized)
    const info = await stat(absolute, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return undefined
    const metadata = info.isFile() ? await this.#readFileMetadata(normalized) : undefined
    const entry: WorkspaceStat = {
      path: normalized,
      type: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? Number(info.size) : undefined,
      mtime: Number(info.mtimeNs) / 1e6,
      revision: info.isFile() ? `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.ctimeNs}:${info.mtimeNs}` : undefined,
      mediaType: metadata?.mediaType,
      metadata: metadata?.metadata,
    }
    if (includeDigest && info.isFile()) entry.digest = await fileDigest(absolute)
    return entry
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    await this.#pathLock(this.root, path, async () => {
      await this.#assertPathComponents(path)
      await mkdir(resolveInside(this.root, path), { recursive: options.recursive ?? true })
    })
  }

  async removeEmptyDirectory(path: string): Promise<void> {
    await this.#pathLock(this.root, path, async () => {
      await this.#assertPathComponents(path, false)
      const absolute = resolveInside(this.root, path)
      const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
      })
      // Windows rmdir can remove a directory junction instead of rejecting it.
      if (!info || info.isSymbolicLink()) return
      await rmdir(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
      })
    })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await this.#pathLock(this.root, path, () => this.#rm(path, options))
  }

  async #rm(path: string, options: RmOptions = {}): Promise<void> {
    await this.#assertPathComponents(path, false)
    const normalized = normalizeWorkspacePath(path)
    if (options.ifDigest !== undefined) {
      const current = await this.#stat(normalized)
      if (options.ifDigest === null ? current !== undefined : current?.digest !== options.ifDigest) {
        throw workspaceConflictError(path, options.ifDigest, current?.digest)
      }
    }
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
      await file?.close()
    }
    let missingTargetError: NodeJS.ErrnoException | undefined
    await rm(resolveInside(this.root, path), {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    }).catch(async (error: NodeJS.ErrnoException) => {
      // Preserve non-recursive empty-directory removal before sidecar cleanup.
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
    for (const key of this.#files.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/`)) this.#files.delete(key)
    }
    if (metadata.root) await rm(resolveInside(this.#fileMetadataRoot, normalized), { force: true, recursive: true })
    await rm(marker, { force: true })
    if (missingTargetError) throw missingTargetError
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
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
      const before = from && Object.hasOwn(from.entries, path) ? from.entries[path] : undefined
      const after = Object.hasOwn(to.entries, path) ? to.entries[path] : undefined
      if (!before && after) entries.push({ path, type: "added", after })
      else if (before && !after) entries.push({ path, type: "removed", before })
      else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata))) {
        entries.push({ path, type: "modified", before, after })
      }
    }
    return { from: from?.id, to: to.id, entries }
  }

  async getMeta(key: string): Promise<unknown> {
    return structuredClone((await this.#readMeta()).get(key))
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.#pathLock(this.root, ".vitehub/metadata", async () => {
      const metadata = new Map(await this.#readMeta())
      metadata.set(key, value)
      await this.#writeMeta(metadata)
    })
  }

  async #createSnapshot(name?: string): Promise<WorkspaceSnapshot> {
    const entries: WorkspaceSnapshot["entries"] = Object.create(null)
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

  async #readMeta(): Promise<Map<string, unknown>> {
    const info = await stat(this.#metaPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) {
      this.#metaCache = undefined
      return new Map()
    }
    if (this.#metaCache?.ino === info.ino && this.#metaCache.mtimeMs === info.mtimeMs && this.#metaCache.size === info.size) return this.#metaCache.value
    const content = await readFile(this.#metaPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!content) {
      this.#metaCache = { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, value: new Map() }
      return this.#metaCache.value
    }
    const value: unknown = JSON.parse(content)
    const metadata = !value || Object(value) !== value || Array.isArray(value)
      ? new Map<string, unknown>()
      : new Map(Object.entries(Object(value)))
    this.#metaCache = { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, value: metadata }
    return metadata
  }

  async #writeMeta(metadata: Map<string, unknown>) {
    const { dirname } = await import("node:path")
    const temp = `${this.#metaPath}.${randomUUID()}.tmp`
    await mkdir(dirname(this.#metaPath), { recursive: true })
    try {
      await writeFile(temp, JSON.stringify(Object.fromEntries(metadata), null, 2))
      await rename(temp, this.#metaPath)
    }
    catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export function createLocalWorkspaceStore(root: string, options: LocalWorkspaceStoreLockOptions = {}): WorkspaceStore {
  if (!root) throw workspaceError("[vitehub] Local workspace store requires a root directory.")
  if (options.locks !== undefined && options.locks !== "filesystem" && options.locks !== "process") {
    throw workspaceError("[vitehub] Local workspace store locks must be \"filesystem\" or \"process\".")
  }
  if (options.ignore !== undefined && options.ignore !== "git") {
    throw workspaceError("[vitehub] Local workspace store ignore must be \"git\".")
  }
  return new LocalWorkspaceStore(root, options)
}
