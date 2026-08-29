import { readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

export default function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): KVRuntimeDriver {
  const driver = createDriver(options) as KVRuntimeDriver
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions) => {
    const root = resolve(options.base)
    const keys: string[] = []

    async function* walk(directory: string): AsyncGenerator<string> {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          yield* walk(path)
          continue
        }
        if (entry.isFile()) yield relative(root, path).split(sep).join(":")
      }
    }

    for await (const key of walk(root)) {
      if (key <= (cursor ?? "") || !key.startsWith(prefix)) continue
      keys.push(key)
      if (keys.length === limit) return { keys, cursor: key }
    }
    return { keys }
  }
  return driver
}
