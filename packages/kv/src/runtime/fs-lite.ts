import { readdir } from "node:fs/promises"
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
        entries = await readdir(directory, { withFileTypes: true })
      }
      catch (error) {
        if (directory === root && error instanceof Error && "code" in error && error.code === "ENOENT") return
        throw error
      }
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      for (const entry of entries) {
        const afterName = after[0]
        const comparison = afterName === undefined ? 1 : entry.name < afterName ? -1 : entry.name > afterName ? 1 : 0
        if (comparison < 0) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          yield* walk(path, comparison === 0 ? after.slice(1) : [])
          continue
        }
        if (entry.isFile() && comparison !== 0) yield relative(root, path)
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
