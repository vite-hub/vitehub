import { opendir } from "node:fs/promises"
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
        const isAfterEntry = afterEntry
        if (!afterEntry && entry.name !== afterName) continue
        afterEntry = true
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          yield* walk(path, isAfterEntry ? [] : after.slice(1))
          continue
        }
        if (entry.isFile() && isAfterEntry) yield relative(root, path)
      }
    }

    const after = cursor ? decodeURIComponent(cursor).split("/") : []
    let scanned = 0
    for await (const path of walk(root, after)) {
      scanned++
      const key = path.split(sep).join(":")
      if (key.startsWith(prefix)) keys.push(key)
      if (scanned === limit) return { keys, cursor: encodeURIComponent(path.split(sep).join("/")) }
    }
    return { keys }
  }
  return driver
}
