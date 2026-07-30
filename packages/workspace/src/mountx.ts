import { constants } from "node:fs"
import { posix } from "node:path"

import {
  fsError,
  normalizePath,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
} from "mountx"

import { contentToBytes } from "./core/path.ts"

import type { WorkspaceEntry, WorkspaceSession } from "./core/types.ts"
import type { DirentLike, FileHandleLike, FsDriver, StatsLike } from "mountx"

export interface WorkspaceMountXDriverOptions {
  readOnly?: boolean
}

interface OpenFlags {
  append: boolean
  create: boolean
  exclusive: boolean
  read: boolean
  truncate: boolean
  write: boolean
}

interface OpenFile {
  data: Uint8Array
  flushedVersion: number
  mediaType?: string
  metadata?: Record<string, unknown>
  orphan: boolean
  path: string
  refs: number
  version: number
}

const empty = new Uint8Array()
const openAccessMode = 3
const blockSize = 4096
const capacityBlocks = 1_048_576
const capacityFiles = 1_048_576

function workspacePath(path: string) {
  return path === "/" ? "" : path.slice(1)
}

function mountPath(path: string) {
  return normalizePath(`/${path}`)
}

function copyBytes(value: string | Uint8Array) {
  return new Uint8Array(contentToBytes(value))
}

function resizeBytes(value: Uint8Array, length: number) {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("File length must be a non-negative safe integer.")
  if (length === value.byteLength) return value
  const resized = new Uint8Array(length)
  resized.set(value.subarray(0, length))
  return resized
}

function parseOpenFlags(flags: string | number, path: string): OpenFlags {
  if (typeof flags === "string") {
    const parsed = {
      a: { append: true, create: true, exclusive: false, read: false, truncate: false, write: true },
      "a+": { append: true, create: true, exclusive: false, read: true, truncate: false, write: true },
      ax: { append: true, create: true, exclusive: true, read: false, truncate: false, write: true },
      "ax+": { append: true, create: true, exclusive: true, read: true, truncate: false, write: true },
      r: { append: false, create: false, exclusive: false, read: true, truncate: false, write: false },
      "r+": { append: false, create: false, exclusive: false, read: true, truncate: false, write: true },
      rs: { append: false, create: false, exclusive: false, read: true, truncate: false, write: false },
      "rs+": { append: false, create: false, exclusive: false, read: true, truncate: false, write: true },
      w: { append: false, create: true, exclusive: false, read: false, truncate: true, write: true },
      "w+": { append: false, create: true, exclusive: false, read: true, truncate: true, write: true },
      wx: { append: false, create: true, exclusive: true, read: false, truncate: true, write: true },
      "wx+": { append: false, create: true, exclusive: true, read: true, truncate: true, write: true },
    } satisfies Record<string, OpenFlags>
    const result = parsed[flags as keyof typeof parsed]
    if (result) return result
    throw fsError("EINVAL", { message: `Invalid open flag: ${flags}`, path, syscall: "open" })
  }

  const access = flags & openAccessMode
  return {
    append: Boolean(flags & constants.O_APPEND),
    create: Boolean(flags & constants.O_CREAT),
    exclusive: Boolean(flags & constants.O_EXCL),
    read: access === constants.O_RDONLY || access === constants.O_RDWR,
    truncate: Boolean(flags & constants.O_TRUNC),
    write: access === constants.O_WRONLY || access === constants.O_RDWR,
  }
}

function fileMode(entry: WorkspaceEntry) {
  if (entry.type === "directory") return S_IFDIR | 0o755
  if (entry.metadata?.gitMode === "120000") return S_IFLNK | 0o777
  return S_IFREG | (entry.metadata?.gitMode === "100755" ? 0o755 : 0o644)
}

function dirent(entry: WorkspaceEntry): DirentLike {
  const symbolic = entry.metadata?.gitMode === "120000"
  return {
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => entry.type === "directory",
    isFIFO: () => false,
    isFile: () => entry.type === "file" && !symbolic,
    isSocket: () => false,
    isSymbolicLink: () => symbolic,
    name: posix.basename(entry.path),
    parentPath: mountPath(posix.dirname(entry.path)),
  }
}

export function createWorkspaceDriver(
  session: WorkspaceSession,
  options: WorkspaceMountXDriverOptions = {},
): FsDriver {
  const readOnly = options.readOnly ?? false
  const created = Date.now()
  const inodes = new Map<string, number>()
  const openFiles = new Map<string, OpenFile>()
  const acquiring = new Map<string, Promise<OpenFile>>()
  let nextFd = 3
  let nextInode = 1

  function mutable(syscall: string, path: string) {
    if (readOnly) throw fsError("EROFS", { path, syscall })
  }

  async function findEntry(path: string): Promise<WorkspaceEntry | undefined> {
    if (path === "/") return { path: "", type: "directory" }
    const target = workspacePath(path)
    const parent = posix.dirname(target)
    return (await session.list(parent === "." ? "" : parent)).find(entry => entry.path === target)
  }

  async function readSymlink(path: string, entry?: WorkspaceEntry) {
    const found = entry ?? await findEntry(path)
    if (!found) throw fsError("ENOENT", { path, syscall: "readlink" })
    if (found.metadata?.gitMode !== "120000") throw fsError("EINVAL", { path, syscall: "readlink" })
    return await session.readFile(found.path)
  }

  async function resolve(path: string, followFinal = true): Promise<{ entry?: WorkspaceEntry, path: string }> {
    let current = normalizePath(path)
    for (let depth = 0; depth <= 40; depth += 1) {
      if (current === "/") return { entry: { path: "", type: "directory" }, path: current }
      const segments = current.slice(1).split("/")
      let prefix = ""
      let redirected = false
      for (const [index, segment] of segments.entries()) {
        prefix = `${prefix}/${segment}`
        const entry = await findEntry(prefix)
        const final = index === segments.length - 1
        if (!entry) return final ? { path: prefix } : { path: current }
        if (entry.metadata?.gitMode === "120000" && (followFinal || !final)) {
          const target = await readSymlink(prefix, entry)
          const remainder = segments.slice(index + 1).join("/")
          current = normalizePath(posix.resolve(posix.dirname(prefix), target, remainder))
          redirected = true
          break
        }
        if (!final && entry.type !== "directory")
          throw fsError("ENOTDIR", { path: prefix, syscall: "stat" })
        if (final) return { entry, path: prefix }
      }
      if (!redirected) return { path: current }
    }
    throw fsError("ELOOP", { path, syscall: "stat" })
  }

  function inode(path: string) {
    let value = inodes.get(path)
    if (value === undefined) {
      value = nextInode
      nextInode += 1
      inodes.set(path, value)
    }
    return value
  }

  function stats(path: string, entry: WorkspaceEntry, size = entry.size ?? 0): StatsLike {
    const mode = fileMode(entry)
    const timestamp = entry.mtime ?? created
    return {
      atimeMs: timestamp,
      birthtimeMs: timestamp,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      ctimeMs: timestamp,
      dev: 0,
      gid: process.getgid?.() ?? 0,
      ino: inode(path),
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => entry.type === "directory",
      isFIFO: () => false,
      isFile: () => entry.type === "file" && entry.metadata?.gitMode !== "120000",
      isSocket: () => false,
      isSymbolicLink: () => entry.metadata?.gitMode === "120000",
      mode,
      mtimeMs: timestamp,
      nlink: entry.type === "directory" ? 2 : 1,
      rdev: 0,
      size,
      uid: process.getuid?.() ?? 0,
    }
  }

  async function requireEntry(
    path: string,
    syscall: string,
    followFinal = true,
  ): Promise<{ entry: WorkspaceEntry, path: string }> {
    const resolved = await resolve(path, followFinal)
    if (!resolved.entry) throw fsError("ENOENT", { path, syscall })
    return { entry: resolved.entry, path: resolved.path }
  }

  async function requireParent(path: string, syscall: string) {
    const parent = await requireEntry(posix.dirname(path), syscall)
    if (parent.entry.type !== "directory") throw fsError("ENOTDIR", { path, syscall })
    return parent.path
  }

  async function flush(file: OpenFile) {
    while (!file.orphan && file.flushedVersion < file.version) {
      const version = file.version
      const data = copyBytes(file.data)
      await session.writeFile(workspacePath(file.path), data, {
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      file.flushedVersion = version
    }
  }

  async function acquire(path: string, entry: WorkspaceEntry, data?: Uint8Array) {
    const existing = openFiles.get(path)
    if (existing) {
      existing.refs += 1
      return existing
    }
    const pending = acquiring.get(path)
    if (pending) {
      const acquired = await pending
      acquired.refs += 1
      return acquired
    }
    const promise = (async (): Promise<OpenFile> => {
      const value = data ?? await session.readFile(entry.path, { encoding: "binary" })
      const file: OpenFile = {
        data: copyBytes(value),
        flushedVersion: 0,
        mediaType: entry.mediaType,
        metadata: entry.metadata,
        orphan: false,
        path,
        refs: 1,
        version: 0,
      }
      openFiles.set(path, file)
      return file
    })()
    acquiring.set(path, promise)
    try {
      return await promise
    }
    finally {
      acquiring.delete(path)
    }
  }

  function fileHandle(file: OpenFile, flags: OpenFlags): FileHandleLike {
    let closed = false
    let position = 0

    function begin(syscall: string, write = false) {
      if (closed || (write ? !flags.write : !flags.read))
        throw fsError("EBADF", { path: file.path, syscall })
    }

    return {
      fd: nextFd++,
      async close() {
        if (closed) return
        closed = true
        file.refs -= 1
        try {
          await flush(file)
        }
        finally {
          if (
            file.refs === 0
            && (file.orphan || file.flushedVersion === file.version)
            && openFiles.get(file.path) === file
          )
            openFiles.delete(file.path)
        }
      },
      async datasync() {
        begin("fdatasync")
        await flush(file)
      },
      async read(buffer, offset = 0, length = buffer.byteLength - (offset ?? 0), at) {
        begin("read")
        const start = offset ?? 0
        const count = length ?? buffer.byteLength - start
        const from = at ?? position
        if (start < 0 || count < 0 || from < 0 || start + count > buffer.byteLength)
          throw new RangeError("Read range is outside the supplied buffer.")
        const bytesRead = Math.max(0, Math.min(count, file.data.byteLength - from))
        if (bytesRead) buffer.set(file.data.subarray(from, from + bytesRead), start)
        if (at === undefined || at === null) position += bytesRead
        return { buffer, bytesRead }
      },
      async stat() {
        begin("fstat")
        return stats(file.path, {
          mediaType: file.mediaType,
          metadata: file.metadata,
          path: workspacePath(file.path),
          size: file.data.byteLength,
          type: "file",
        }, file.data.byteLength)
      },
      async sync() {
        begin("fsync")
        await flush(file)
      },
      async truncate(length = 0) {
        begin("ftruncate", true)
        file.data = resizeBytes(file.data, length)
        file.version += 1
      },
      async write(buffer, offset = 0, length = buffer.byteLength - (offset ?? 0), at) {
        begin("write", true)
        const start = offset ?? 0
        const count = length ?? buffer.byteLength - start
        const from = flags.append ? file.data.byteLength : at ?? position
        if (start < 0 || count < 0 || from < 0 || start + count > buffer.byteLength)
          throw new RangeError("Write range is outside the supplied buffer.")
        if (from + count > file.data.byteLength) file.data = resizeBytes(file.data, from + count)
        file.data.set(buffer.subarray(start, start + count), from)
        file.version += 1
        if (flags.append || at === undefined || at === null) position = from + count
        return { buffer, bytesWritten: count }
      },
    }
  }

  function remapOpenFiles(from: string, to: string) {
    for (const [path, file] of Array.from(openFiles)) {
      if (path !== from && !path.startsWith(`${from}/`)) continue
      const target = `${to}${path.slice(from.length)}`
      openFiles.delete(path)
      file.path = target
      openFiles.set(target, file)
    }
    for (const [path, value] of Array.from(inodes)) {
      if (path !== from && !path.startsWith(`${from}/`)) continue
      inodes.delete(path)
      inodes.set(`${to}${path.slice(from.length)}`, value)
    }
  }

  async function copyEntry(source: WorkspaceEntry, from: string, to: string) {
    const relative = source.path.slice(workspacePath(from).length).replace(/^\/+/, "")
    const destination = workspacePath(relative ? posix.join(to, relative) : to)
    if (source.type === "directory") {
      await session.mkdir(destination, { recursive: true })
      return
    }
    await session.writeFile(destination, await session.readFile(source.path, { encoding: "binary" }), {
      mediaType: source.mediaType,
      metadata: source.metadata,
    })
  }

  const driver: FsDriver = {
    capabilities: {
      atomicRename: false,
      caseSensitive: true,
      handles: true,
      readOnly,
      statfs: true,
      symlinks: true,
      truncate: true,
    },
    async lstat(path) {
      const resolved = await requireEntry(path, "lstat", false)
      const open = openFiles.get(resolved.path)
      return stats(resolved.path, resolved.entry, open?.data.byteLength ?? resolved.entry.size)
    },
    async mkdir(path, mkdirOptions = {}) {
      const resolved = normalizePath(path)
      mutable("mkdir", resolved)
      if (resolved === "/") {
        if (mkdirOptions.recursive) return
        throw fsError("EEXIST", { path: resolved, syscall: "mkdir" })
      }
      const existing = await resolve(resolved, false)
      if (existing.entry) {
        if (mkdirOptions.recursive && existing.entry.type === "directory") return
        throw fsError("EEXIST", { path: resolved, syscall: "mkdir" })
      }
      if (!mkdirOptions.recursive) await requireParent(resolved, "mkdir")
      await session.mkdir(workspacePath(resolved), { recursive: mkdirOptions.recursive })
      return resolved
    },
    async open(path, rawFlags = "r", mode = 0o666) {
      let resolved = await resolve(path)
      const flags = parseOpenFlags(rawFlags, resolved.path)
      if (flags.write || flags.create || flags.truncate) mutable("open", resolved.path)
      if (!resolved.entry) {
        if (!flags.create) throw fsError("ENOENT", { path: resolved.path, syscall: "open" })
        await requireParent(resolved.path, "open")
        const metadata = mode & 0o111 ? { gitMode: "100755" } : undefined
        await session.writeFile(workspacePath(resolved.path), empty, { metadata })
        resolved = {
          entry: { metadata, path: workspacePath(resolved.path), size: 0, type: "file" },
          path: resolved.path,
        }
      }
      else if (flags.create && flags.exclusive) {
        throw fsError("EEXIST", { path: resolved.path, syscall: "open" })
      }
      const entry = resolved.entry
      if (!entry) throw fsError("ENOENT", { path: resolved.path, syscall: "open" })
      if (entry.type === "directory") {
        if (flags.write) throw fsError("EISDIR", { path: resolved.path, syscall: "open" })
        return {
          async close() {},
          async read() {
            throw fsError("EISDIR", { path: resolved.path, syscall: "read" })
          },
          async stat() {
            return stats(resolved.path, entry)
          },
          async truncate() {
            throw fsError("EISDIR", { path: resolved.path, syscall: "ftruncate" })
          },
          async write() {
            throw fsError("EISDIR", { path: resolved.path, syscall: "write" })
          },
        }
      }
      const file = await acquire(resolved.path, entry, flags.truncate ? empty : undefined)
      if (flags.truncate) {
        file.data = empty
        file.version += 1
      }
      return fileHandle(file, flags)
    },
    async readlink(path) {
      const resolved = await requireEntry(path, "readlink", false)
      return await readSymlink(resolved.path, resolved.entry)
    },
    async readdir(path) {
      const resolved = await requireEntry(path, "scandir")
      if (resolved.entry.type !== "directory")
        throw fsError("ENOTDIR", { path: resolved.path, syscall: "scandir" })
      return (await session.list(workspacePath(resolved.path))).map(dirent)
    },
    async rename(oldPath, newPath) {
      const from = normalizePath(oldPath)
      const to = normalizePath(newPath)
      mutable("rename", from)
      const source = await requireEntry(from, "rename", false)
      if (from === to) return
      if (source.entry.type === "directory" && (to === from || to.startsWith(`${from}/`)))
        throw fsError("EINVAL", { dest: to, path: from, syscall: "rename" })
      await requireParent(to, "rename")
      const destination = await resolve(to, false)
      if (destination.entry) {
        if (source.entry.type === "directory" && destination.entry.type !== "directory")
          throw fsError("ENOTDIR", { dest: to, path: from, syscall: "rename" })
        if (source.entry.type !== "directory" && destination.entry.type === "directory")
          throw fsError("EISDIR", { dest: to, path: from, syscall: "rename" })
        if (destination.entry.type === "directory" && (await session.list(destination.entry.path)).length)
          throw fsError("ENOTEMPTY", { dest: to, path: from, syscall: "rename" })
        await session.rm(destination.entry.path, { force: true, recursive: true })
        const replaced = openFiles.get(to)
        if (replaced) {
          replaced.orphan = true
          openFiles.delete(to)
        }
      }
      const entries = source.entry.type === "directory"
        ? [source.entry, ...await session.list(source.entry.path, { recursive: true })]
        : [source.entry]
      for (const entry of entries.sort((left, right) => left.path.length - right.path.length))
        await copyEntry(entry, from, to)
      await session.rm(source.entry.path, { recursive: source.entry.type === "directory" })
      remapOpenFiles(from, to)
    },
    async rmdir(path) {
      const resolved = normalizePath(path)
      mutable("rmdir", resolved)
      const found = await requireEntry(resolved, "rmdir", false)
      if (found.entry.type !== "directory")
        throw fsError("ENOTDIR", { path: resolved, syscall: "rmdir" })
      if (resolved === "/") throw fsError("EBUSY", { path: resolved, syscall: "rmdir" })
      if ((await session.list(found.entry.path)).length)
        throw fsError("ENOTEMPTY", { path: resolved, syscall: "rmdir" })
      await session.rm(found.entry.path)
      inodes.delete(resolved)
    },
    async stat(path) {
      const resolved = await requireEntry(path, "stat")
      const open = openFiles.get(resolved.path)
      return stats(resolved.path, resolved.entry, open?.data.byteLength ?? resolved.entry.size)
    },
    async statfs(path) {
      await requireEntry(path, "statfs")
      const entries = await session.list("", { recursive: true })
      const usedBlocks = Math.ceil(entries.reduce((total, entry) => total + (entry.size ?? 0), 0) / blockSize)
      const availableBlocks = Math.max(0, capacityBlocks - usedBlocks)
      return {
        bavail: availableBlocks,
        bfree: availableBlocks,
        blocks: capacityBlocks,
        bsize: blockSize,
        ffree: Math.max(0, capacityFiles - entries.length),
        files: capacityFiles,
        type: 0x56495445,
      }
    },
    async symlink(target, path) {
      const resolved = normalizePath(path)
      mutable("symlink", resolved)
      if ((await resolve(resolved, false)).entry)
        throw fsError("EEXIST", { path: resolved, syscall: "symlink" })
      await requireParent(resolved, "symlink")
      await session.writeFile(workspacePath(resolved), target, {
        metadata: { gitMode: "120000", symlinkTarget: target },
      })
    },
    async truncate(path, length = 0) {
      const resolved = await requireEntry(path, "truncate")
      mutable("truncate", resolved.path)
      if (resolved.entry.type === "directory")
        throw fsError("EISDIR", { path: resolved.path, syscall: "truncate" })
      const open = await acquire(resolved.path, resolved.entry)
      open.data = resizeBytes(open.data, length)
      open.version += 1
      open.refs -= 1
      await flush(open)
      if (open.refs === 0 && openFiles.get(open.path) === open) openFiles.delete(open.path)
    },
    async unlink(path) {
      const resolved = normalizePath(path)
      mutable("unlink", resolved)
      const found = await requireEntry(resolved, "unlink", false)
      if (found.entry.type === "directory")
        throw fsError("EISDIR", { path: resolved, syscall: "unlink" })
      await session.rm(found.entry.path)
      const open = openFiles.get(resolved)
      if (open) {
        open.orphan = true
        openFiles.delete(resolved)
      }
      inodes.delete(resolved)
    },
  }

  return driver
}
