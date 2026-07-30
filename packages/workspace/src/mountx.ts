import { posix } from "node:path"

import { createUnstorageDriver } from "mountx/drivers/unstorage"

import type { WorkspaceEntry, WorkspaceSession } from "./core/types.ts"
import type { FsDriver } from "mountx"

export interface WorkspaceMountXDriverOptions {
  dirMode?: number
  fileMode?: number
  gid?: number
  readOnly?: boolean
  uid?: number
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

function createWorkspaceStorage(session: WorkspaceSession, readOnly: boolean) {
  const storage = {
    async getItem(key: string) {
      const path = keyToPath(key)
      const entry = await findEntry(session, path)
      if (entry?.type !== "file") return null
      return await session.readFile(path, { encoding: "binary" })
    },
    async getItemRaw(key: string) {
      const path = keyToPath(key)
      const entry = await findEntry(session, path)
      if (entry?.type !== "file") return null
      return await session.readFile(path, { encoding: "binary" })
    },
    async getKeys(base: string) {
      const path = keyToPath(base)
      const entries = await session.list(path, { recursive: true })
      return entries
        .filter(entry => entry.type === "file")
        .map(entry => pathToKey(entry.path))
    },
    async getMeta(key: string) {
      const entry = await findEntry(session, keyToPath(key))
      if (!entry) return null
      return {
        mtime: entry.mtime === undefined ? undefined : new Date(entry.mtime),
        size: entry.size,
      }
    },
    async hasItem(key: string) {
      return (await findEntry(session, keyToPath(key)))?.type === "file"
    },
    ...(readOnly
      ? {}
      : {
          async removeItem(key: string) {
            await session.rm(keyToPath(key), { force: true })
          },
          async setItemRaw(key: string, value: unknown) {
            await session.writeFile(keyToPath(key), valueToBytes(value))
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
  return createUnstorageDriver(createWorkspaceStorage(session, readOnly), {
    dirMode: options.dirMode,
    fileMode: options.fileMode,
    gid: options.gid,
    readOnly,
    uid: options.uid,
  })
}
