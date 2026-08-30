import { randomUUID } from "node:crypto"
import { opendir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

export default function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  const continuations = new Map<string, { iterator: AsyncGenerator<string>; timeout: NodeJS.Timeout }>()
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions) => {
    const root = resolve(options.base)
    const keys: string[] = []

    async function* walk(directory: string): AsyncGenerator<string> {
      let entries
      try {
        entries = await opendir(directory)
      }
      catch (error) {
        if (directory === root && error instanceof Error && "code" in error && error.code === "ENOENT") return
        throw error
      }
      for await (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          yield* walk(path)
          continue
        }
        if (entry.isFile()) yield relative(root, path)
      }
    }

    const continuation = cursor ? continuations.get(cursor) : undefined
    const iterator = continuation?.iterator ?? (cursor ? undefined : walk(root))
    if (!iterator) throw new TypeError("Invalid or expired fs-lite KV cursor.")
    if (cursor && continuation) {
      clearTimeout(continuation.timeout)
      continuations.delete(cursor)
    }
    let scanned = 0
    while (scanned < limit) {
      const entry = await iterator.next()
      if (entry.done) return { keys }
      const path = entry.value
      scanned++
      const key = path.split(sep).join(":")
      if (key.startsWith(prefix)) keys.push(key)
    }
    const nextCursor = randomUUID()
    const timeout = setTimeout(() => {
      continuations.delete(nextCursor)
      void iterator.return(undefined)
    }, 60_000)
    timeout.unref()
    continuations.set(nextCursor, { iterator, timeout })
    return { keys, cursor: nextCursor }
  }
  return driver
}
