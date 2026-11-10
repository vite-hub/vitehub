import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, mkdtemp, opendir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"
import { lock } from "proper-lockfile"

import type { KVListOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

// unstorage's atomic writes and setIfAbsentItem() stage values in files with this name. They are not keys.
const temporaryFile = /^\.unstorage-tmp-[\da-z-]+$/
// Layout records point to an exclusively allocated metadata directory, outside the encoded key namespace.
const layoutRecord = /^\.unstorage-tmp-vitehub-layout-v1(?:-\d+)?$/
const layoutRecordName = ".unstorage-tmp-vitehub-layout-v1"
const layoutMarkerName = ".unstorage-tmp-vitehub-record"
const keyPrefix = "key-"

// Each key is one file in the base folder, so `signups` and `signups:reset-at` can both exist.
// The fixed prefix separates every application key from metadata and temporary files.
function fileName(key: string): string {
  return keyPrefix + key.replace(/[%:]/g, encodeURIComponent)
}

// Returns undefined for a file that is not a key, such as a temporary file or a name with another escape.
function keyOf(name: string): string | undefined {
  if (!name.startsWith(keyPrefix)) return
  const key = name.slice(keyPrefix.length).replace(/%(?:25|3A)/g, decodeURIComponent)
  return fileName(key) === name ? key : undefined
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch (error) {
    if (hasCode(error, "ENOENT")) return false
    throw error
  }
}

// Legacy root names are literal keys, even when they look encoded. Stage the whole old layout
// before publishing any encoded names, so neither root files nor directories can claim another key's destination.
async function migrateKeys(root: string): Promise<string> {
  await mkdir(root, { recursive: true })
  let recordPath = ""
  let layout = ""
  const candidates: string[] = []
  while (!layout) {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !layoutRecord.test(entry.name)) continue
      const path = join(root, entry.name)
      const value = await readFile(path, "utf8").catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return ""
        throw error
      })
      if (!/^\.unstorage-tmp-vitehub-migration-[a-z\d]{6}$/i.test(value)) continue
      const identity = await Promise.all([lstat(path), lstat(join(root, value, layoutMarkerName))]).catch((error: unknown) => {
        if (hasCode(error, "ENOENT", "ENOTDIR")) return undefined
        throw error
      })
      // Legacy values can imitate any name or contents, but cannot create hard links.
      if (!identity) continue
      const [record, marker] = identity
      if (!record.isFile() || !marker.isFile() || record.dev !== marker.dev || record.ino !== marker.ino) continue
      recordPath = path
      layout = join(root, value)
      break
    }
    if (layout) break
    let name = layoutRecordName
    for (let suffix = 1; entries.some(entry => entry.name === name); suffix++) name = `${layoutRecordName}-${suffix}`
    const candidate = await mkdtemp(join(root, ".unstorage-tmp-vitehub-migration-"))
    candidates.push(candidate)
    const temporary = join(root, `.unstorage-tmp-${randomUUID()}`)
    try {
      await writeFile(temporary, basename(candidate))
      await link(temporary, join(candidate, layoutMarkerName))
      // Publish one shared workspace without replacing another initializer's record.
      await link(temporary, join(root, name))
      layout = candidate
      recordPath = join(root, name)
    }
    catch (error) {
      // Another initializer can stage this unpublished workspace before its marker is linked.
      if (!hasCode(error, "EEXIST", "ENOENT")) throw error
    }
    finally {
      await rm(temporary, { force: true })
    }
  }
  // The unique workspace cannot contain legacy keys. Lock inside it so only the store must be writable.
  const release = await lock(layout, { lockfilePath: join(layout, "lock"), retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } })
  try {
    // Another initializer may be staging these directories. Cleanup must share its migration lock.
    for (const candidate of candidates) {
      if (candidate !== layout) await rm(candidate, { force: true, recursive: true })
    }
    const complete = join(layout, "complete")
    if (await exists(complete)) return layout
    const legacy = join(layout, "legacy")
    await mkdir(legacy, { recursive: true })
    const staged = join(layout, "staged")
    if (!await exists(staged)) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name === basename(layout) || join(root, entry.name) === recordPath) continue
        if (!entry.isDirectory() && (!entry.isFile() || (temporaryFile.test(entry.name) && !layoutRecord.test(entry.name)))) continue
        await rename(join(root, entry.name), join(legacy, entry.name))
      }
      await writeFile(staged, "")
    }
    for (const file of await readdir(legacy, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || (temporaryFile.test(file.name) && !layoutRecord.test(file.name))) continue
      const path = join(file.parentPath, file.name)
      const destination = join(root, fileName(relative(legacy, path).split(sep).join(":")))
      try {
        await link(path, destination)
      }
      catch (error) {
        // Only a retry after staging can have published this file already. A directory is never a migrated value.
        if (!hasCode(error, "EEXIST")) throw error
        const source = await lstat(path)
        const target = await lstat(destination)
        if (!target.isFile() || target.dev !== source.dev || target.ino !== source.ino) throw error
      }
    }
    await writeFile(complete, "")
    await rm(legacy, { force: true, recursive: true })
    return layout
  }
  finally {
    await release()
  }
}

export default async function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): Promise<KVRuntimeDriver> {
  const root = resolve(options.base)
  const layout = await migrateKeys(root)
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
  driver.clear = async () => {
    // Delete only encoded key files, keeping the layout record and its workspace for later initialization.
    const entries = await readdir(root).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return []
      throw error
    })
    for (const entry of entries) {
      if (keyOf(entry) !== undefined) await rm(join(root, entry), { force: true, recursive: true })
    }
  }
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
    for await (const entry of entries) {
      if (entry.name !== basename(layout) && !layoutRecord.test(entry.name)) yield entry.isFile() ? keyOf(entry.name) : undefined
    }
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
