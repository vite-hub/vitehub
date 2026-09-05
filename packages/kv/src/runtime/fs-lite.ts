import { opendir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"

export default function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  const continuations = new Map<string, { iterator: AsyncGenerator<string | undefined>; timeout: NodeJS.Timeout }>()
  const maximumContinuations = 32

  function releaseContinuation(cursor: string): void {
    const continuation = continuations.get(cursor)
    if (!continuation) return
    clearTimeout(continuation.timeout)
    continuations.delete(cursor)
    void continuation.iterator.return(undefined)
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

    const continuation = cursor ? continuations.get(cursor) : undefined
    const iterator = continuation?.iterator ?? (cursor ? undefined : walk())
    if (!iterator) {
      throw Object.assign(kvErrorDiagnostics.KV_R0003({ message: "Invalid or expired fs-lite KV cursor." }), { code: "KV_CURSOR_EXPIRED" })
    }
    if (cursor && continuation) {
      clearTimeout(continuation.timeout)
      continuations.delete(cursor)
    }
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
    const nextCursor = crypto.randomUUID()
    const timeout = setTimeout(() => {
      releaseContinuation(nextCursor)
    }, 15 * 60_000)
    timeout.unref()
    continuations.set(nextCursor, { iterator, timeout })
    while (continuations.size > maximumContinuations) {
      const oldestCursor = continuations.keys().next().value
      if (oldestCursor) releaseContinuation(oldestCursor)
    }
    return { keys, cursor: nextCursor }
  }
  return driver
}
