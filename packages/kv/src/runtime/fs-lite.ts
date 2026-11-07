import { randomUUID } from "node:crypto"
import { link, mkdir, opendir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

// unstorage's atomic writes and setIfAbsentItem() stage values in files with this name. They are not keys.
const temporaryFile = /^\.unstorage-tmp-[\da-z-]+$/

// Each key is one file in the base folder, so `signups` and `signups:reset-at` can both exist.
// The file name is the key with `%` and `:` escaped as in a URL, for example `signups%3Areset-at`.
function fileName(key: string): string {
  return key.replace(/[%:]/g, encodeURIComponent)
}

// Returns undefined for a file that is not a key, such as a temporary file or a name with another escape.
function keyOf(name: string): string | undefined {
  const key = name.replace(/%(?:25|3A)/g, decodeURIComponent)
  return !temporaryFile.test(name) && fileName(key) === name ? key : undefined
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code)
}

// Stores written by older versions keep the key `a:b` as the file `a/b`. Move those files once, so their keys stay readable.
// Those versions listed and cleared every file under the base folder as a key, so this moves only keys.
async function moveNestedKeys(root: string): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  }
  catch (error) {
    if (hasCode(error, "ENOENT")) return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const nested = await readdir(directory, { recursive: true, withFileTypes: true })
    for (const file of nested) {
      if (!file.isFile() || temporaryFile.test(file.name)) continue
      const path = join(file.parentPath, file.name)
      try {
        await link(path, join(root, fileName(relative(root, path).split(sep).join(":"))))
      }
      catch (error) {
        // A file under the new name is newer, so the old file is stale.
        if (!hasCode(error, "EEXIST")) throw error
      }
      await rm(path, { force: true })
    }
    // Deepest folders first, so each parent is empty when its turn comes.
    const folders = nested.filter(file => file.isDirectory()).map(file => join(file.parentPath, file.name))
    for (const folder of [...folders.sort((a, b) => b.length - a.length), directory]) {
      await rmdir(folder).catch((error: unknown) => {
        // Another process moved it first, or it keeps a file that is not a key.
        if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error
      })
    }
  }
}

export default async function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): Promise<KVRuntimeDriver> {
  const root = resolve(options.base)
  await moveNestedKeys(root)
  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  const { getItem, getItemRaw, getMeta, hasItem, removeItem, setItem, setItemRaw } = driver
  driver.getItem = async (key, operationOptions) => {
    const value = await getItem(fileName(key), operationOptions)
    // unstorage returns filesystem read errors as values rather than rejecting.
    if (value instanceof Error) throw value
    return value
  }
  driver.getItemRaw = async (key, operationOptions) => {
    const value = await getItemRaw?.(fileName(key), operationOptions)
    if (value instanceof Error) throw value
    return value
  }
  driver.getMeta = (key, operationOptions) => getMeta?.(fileName(key), operationOptions) ?? null
  driver.setItem = (key, value, operationOptions) => setItem?.(fileName(key), value, operationOptions)
  driver.setItemRaw = (key, value, operationOptions) => setItemRaw?.(fileName(key), value, operationOptions)
  driver.removeItem = (key, operationOptions) => removeItem?.(fileName(key), operationOptions)
  driver.hasItem = async (key, operationOptions) => {
    // Keep the underlying driver's key validation before resolving its file path.
    if (!await hasItem(fileName(key), operationOptions)) return false
    try {
      return (await stat(join(root, fileName(key)))).isFile()
    }
    catch (error) {
      // A key can be removed between the existence check and stat.
      if (hasCode(error, "ENOENT")) return false
      throw error
    }
  }
  // link() publishes the complete file and fails when the key exists, in one step, also across processes on one disk.
  // fs-lite never expires keys, so the TTL does not apply.
  driver.setIfAbsentItem = async (key, value) => {
    // The underlying driver validates the key before it resolves the file path.
    if (await driver.hasItem(key, {})) return false
    const path = join(root, fileName(key))
    await mkdir(root, { recursive: true })
    // Beside the destination, so link() stays on one disk. Key listings skip unstorage's temporary file names.
    const temporary = join(root, `.unstorage-tmp-${randomUUID()}`)
    await writeFile(temporary, value, "utf8")
    try {
      await link(temporary, path)
      return true
    }
    catch (error) {
      if (hasCode(error, "EEXIST") && (await stat(path)).isFile()) return false
      throw error
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  // Yields each key, or undefined for a skipped entry, which still counts as listing work.
  async function* walk(): AsyncGenerator<string | undefined> {
    let entries
    try {
      entries = await opendir(root)
    }
    catch (error) {
      if (hasCode(error, "ENOENT")) return
      throw error
    }
    for await (const entry of entries) yield entry.isFile() ? keyOf(entry.name) : undefined
  }

  driver.getKeys = async () => {
    const keys: string[] = []
    for await (const key of walk()) {
      if (key !== undefined) keys.push(key)
    }
    return keys
  }
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
    const keys: string[] = []
    const iterator = cursor ? continuations.take(cursor) : walk()
    if (!iterator) throw expired()
    let scanned = 0
    while (scanned < limit) {
      const entry = await iterator.next()
      if (entry.done) return { keys }
      scanned++
      const key = entry.value
      if (key !== undefined && key.startsWith(prefix)) keys.push(key)
    }
    return { keys, cursor: await continuations.retain(iterator) }
  }
  return driver
}
