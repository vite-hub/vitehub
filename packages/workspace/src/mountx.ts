import { posix } from "node:path"

import { createUnstorageDriver } from "mountx/drivers/unstorage"

import type { WorkspaceEntry, WorkspaceSession, WriteFileOptions } from "./core/types.ts"
import type { FsDriver } from "mountx"

export interface WorkspaceMountXDriverOptions {
  readOnly?: boolean
}

function keyToPath(key: string) {
  return key.split(":").join("/")
}

function pathToKey(path: string) {
  return path.split("/").join(":")
}

function valueToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
}

async function findEntry(session: WorkspaceSession, path: string): Promise<WorkspaceEntry | undefined> {
  if (!path) return undefined
  const parent = posix.dirname(path)
  return (await session.list(parent === "." ? "" : parent)).find(entry => entry.path === path)
}

function assertProjectablePath(path: string) {
  const invalidName = path.split("/").find(segment =>
    segment.includes(":") || segment.includes("?") || segment.endsWith("$"),
  )
  if (invalidName) {
    throw Object.assign(
      new Error(`Workspace filename is not representable as an unstorage key: ${invalidName}`),
      { code: "EINVAL", path },
    )
  }
}

function assertProjectableEntry(entry: WorkspaceEntry | undefined) {
  if (entry) assertProjectablePath(entry.path)
  if (entry?.metadata?.gitMode !== "120000") return entry
  throw Object.assign(
    new Error(`MountX cannot project Workspace symlink semantics: ${entry.path}`),
    { code: "ENOTSUP", path: entry.path },
  )
}

function createWorkspaceStorage(session: WorkspaceSession, readOnly: boolean) {
  const writeOptionsByValue = new WeakMap<Uint8Array, WriteFileOptions>()

  async function readItem(key: string) {
    const path = keyToPath(key)
    const entry = assertProjectableEntry(await findEntry(session, path))
    if (entry?.type !== "file") return null
    const value = valueToBytes(await session.readFile(path, { encoding: "binary" }))
    writeOptionsByValue.set(value, { mediaType: entry.mediaType, metadata: entry.metadata })
    return value
  }

  const storage = {
    getItem: readItem,
    getItemRaw: readItem,
    async getKeys(base: string) {
      const path = keyToPath(base)
      const entries = await session.list(path, { recursive: true })
      return entries
        .filter(entry => assertProjectableEntry(entry)?.type === "file")
        .map(entry => pathToKey(entry.path))
    },
    async getMeta(key: string) {
      const entry = assertProjectableEntry(await findEntry(session, keyToPath(key)))
      if (!entry) return null
      return {
        mtime: entry.mtime === undefined ? undefined : new Date(entry.mtime),
        size: entry.size,
      }
    },
    async hasItem(key: string) {
      return assertProjectableEntry(await findEntry(session, keyToPath(key)))?.type === "file"
    },
    ...(readOnly
      ? {}
      : {
          async removeItem(key: string) {
            await session.rm(keyToPath(key), { force: true })
          },
          async setItemRaw(key: string, value: unknown) {
            const path = keyToPath(key)
            const entry = assertProjectableEntry(await findEntry(session, path))
            const writeOptions = value instanceof Uint8Array
              ? writeOptionsByValue.get(value)
              : undefined
            await session.writeFile(path, valueToBytes(value), writeOptions ?? {
              mediaType: entry?.mediaType,
              metadata: entry?.metadata,
            })
          },
        }),
  }

  return storage as unknown as Parameters<typeof createUnstorageDriver>[0]
}

export function createWorkspaceDriver(
  session: WorkspaceSession,
  options: WorkspaceMountXDriverOptions = {},
): FsDriver {
  const readOnly = options.readOnly ?? false
  const driver = createUnstorageDriver(createWorkspaceStorage(session, readOnly), {
    readOnly,
  })

  async function stat(path: string) {
    assertProjectablePath(path)
    const stats = await driver.stat(path)
    const entry = assertProjectableEntry(await findEntry(session, path.replace(/^\/+/, "")))
    if (entry?.metadata?.gitMode === "100755") stats.mode |= 0o111
    return stats
  }

  const singlePathMethods = new Set([
    "chmod",
    "chown",
    "lchown",
    "lutimes",
    "mkdir",
    "open",
    "readlink",
    "readdir",
    "rmdir",
    "statfs",
    "truncate",
    "unlink",
    "utimes",
  ])
  const twoPathMethods = new Set(["link", "rename"])

  return new Proxy(driver, {
    get(target, property) {
      if (property === "stat" || property === "lstat") return stat
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (singlePathMethods.has(property as string)) {
        return (path: string, ...args: unknown[]) => {
          assertProjectablePath(path)
          return value.call(target, path, ...args)
        }
      }
      if (twoPathMethods.has(property as string)) {
        return (from: string, to: string, ...args: unknown[]) => {
          assertProjectablePath(from)
          assertProjectablePath(to)
          return value.call(target, from, to, ...args)
        }
      }
      if (property === "symlink") {
        return (linkTarget: string, path: string, ...args: unknown[]) => {
          assertProjectablePath(path)
          return value.call(target, linkTarget, path, ...args)
        }
      }
      return value.bind(target)
    },
  })
}
