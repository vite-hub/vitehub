import { opendir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

export default function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  const expired = () => kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "expired" })
  const continuations = createKVContinuations<AsyncGenerator<string | undefined>>({
    expired,
    release: iterator => iterator.return(undefined),
  })
  const dispose = driver.dispose
  driver.dispose = async () => {
    try { await continuations.dispose() }
    finally { await dispose?.call(driver) }
  }
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions) => {
    const root = resolve(options.base)
    const keys: string[] = []

    async function* walk(): AsyncGenerator<string | undefined> {
      const pendingDirectories = [root]
      while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop()!
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
            pendingDirectories.push(path)
            yield undefined
            continue
          }
          if (entry.isFile()) yield relative(root, path)
        }
      }
    }

    const iterator = cursor ? continuations.take(cursor) : walk()
    if (!iterator) throw expired()
    let scanned = 0
    while (scanned < limit) {
      const entry = await iterator.next()
      if (entry.done) return { keys }
      scanned++
      const path = entry.value
      if (path === undefined) continue
      const key = path.split(sep).join(":")
      if (key.startsWith(prefix)) keys.push(key)
    }
    return { keys, cursor: await continuations.retain(iterator) }
  }
  return driver
}
