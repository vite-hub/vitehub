import { access, opendir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

export default function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions) => {
    const root = resolve(options.base)
    const keys: string[] = []

    async function* walk(directory: string, after: string[] = []): AsyncGenerator<string> {
      let entries
      try {
        entries = await opendir(directory)
      }
      catch (error) {
        if (directory === root && error instanceof Error && "code" in error && error.code === "ENOENT") return
        throw error
      }
      let afterEntry = after[0] === undefined
      for await (const entry of entries) {
        const afterName = after[0]
        let isAfterEntry = afterEntry
        if (!afterEntry) {
          if (entry.name < (afterName ?? "")) continue
          isAfterEntry = entry.name !== afterName
          afterEntry = true
        }
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          yield* walk(path, isAfterEntry ? [] : after.slice(1))
          continue
        }
        if (entry.isFile() && isAfterEntry) yield relative(root, path)
      }
    }

    const decoded = cursor
      ? JSON.parse(decodeURIComponent(cursor)) as { offset: number; path: string }
      : { offset: 0, path: "" }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursors are untrusted request input.
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || typeof decoded.path !== "string") {
      throw new TypeError("Invalid fs-lite KV cursor.")
    }
    let after = decoded.path === "" ? [] : decoded.path.split("/")
    let restartSkip = 0
    if (after.some(part => part === "" || part === "." || part === "..")) {
      throw new TypeError("Invalid fs-lite KV cursor.")
    }
    if (after.length > 0) {
      try {
        await access(join(root, ...after))
      }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          after = []
          restartSkip = Math.max(0, decoded.offset - 1)
        }
        else throw error
      }
    }
    let scanned = 0
    for await (const path of walk(root, after)) {
      scanned++
      if (restartSkip > 0) {
        restartSkip--
        continue
      }
      const key = path.split(sep).join(":")
      if (key.startsWith(prefix)) keys.push(key)
      if (scanned === limit) {
        return {
          keys,
          cursor: encodeURIComponent(JSON.stringify({
            offset: decoded.offset + scanned,
            path: path.split(sep).join("/"),
          })),
        }
      }
    }
    return { keys }
  }
  return driver
}
