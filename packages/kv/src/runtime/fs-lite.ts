import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, mkdtemp, opendir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"

import createDriver from "unstorage/drivers/fs-lite"
import { lock } from "proper-lockfile"

import type { KVPageOptions, ResolvedFsLiteKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

const temporaryFile = /^\.unstorage-tmp-[\da-z-]+$/
const layoutRecord = /^\.unstorage-tmp-vitehub-layout-v1(?:-\d+)?$/
const layoutRecordName = ".unstorage-tmp-vitehub-layout-v1"
const layoutMarkerName = ".unstorage-tmp-vitehub-record"
const keyPrefix = "key-"

function fileName(key: string): string {
  return keyPrefix + key.replace(/[%:]/g, encodeURIComponent)
}

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
      await link(temporary, join(root, name))
      layout = candidate
      recordPath = join(root, name)
    }
    catch (error) {
      if (!hasCode(error, "EEXIST", "ENOENT")) throw error
    }
    finally {
      await rm(temporary, { force: true })
    }
  }
  const release = await lock(layout, { lockfilePath: join(layout, "lock"), retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } })
  try {
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

function ttlMilliseconds(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw kvErrorDiagnostics.KV_INVALID_TTL()
  const ms = Math.ceil(ttl * 1000)
  if (!Number.isSafeInteger(ms)) throw kvErrorDiagnostics.KV_INVALID_TTL()
  return ms
}

function setExpiry(options: unknown): number | undefined {
  const ttl: unknown = options && typeof options === "object" ? Reflect.get(options, "ttl") : undefined
  if (ttl === undefined || ttl === null || ttl === 0) return
  if (typeof ttl !== "number") throw kvErrorDiagnostics.KV_INVALID_TTL()
  return Date.now() + ttlMilliseconds(ttl)
}

export default async function createFsLiteKVDriver(options: ResolvedFsLiteKVStoreConfig): Promise<KVRuntimeDriver> {
  const root = resolve(options.base)
  const layout = await migrateKeys(root)
  const expiries = join(layout, "expires")
  const expiryPath = (key: string) => join(expiries, createHash("sha256").update(key).digest("hex"))

  async function readExpiry(key: string): Promise<number | undefined> {
    const text = await readFile(expiryPath(key), "utf8").catch((error: unknown) => {
      if (hasCode(error, "ENOENT", "ENOTDIR")) return undefined
      throw error
    })
    const expiresAt = text === undefined ? Number.NaN : Number(text)
    return Number.isSafeInteger(expiresAt) ? expiresAt : undefined
  }

  async function synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const release = await lock(layout, { lockfilePath: join(layout, "lock"), retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } })
    try { return await operation() }
    finally { await release() }
  }

  async function writeExpiry(key: string, expiresAt: number | undefined): Promise<void> {
    if (expiresAt === undefined) {
      await rm(expiryPath(key), { force: true })
      return
    }
    await mkdir(expiries, { recursive: true })
    const temporary = join(expiries, `.tmp-${randomUUID()}`)
    await writeFile(temporary, String(expiresAt))
    await rename(temporary, expiryPath(key))
  }

  async function live(key: string): Promise<boolean> {
    const expiresAt = await readExpiry(key)
    if (expiresAt === undefined || expiresAt > Date.now()) return true
    await rm(join(root, fileName(key)), { force: true })
    await rm(expiryPath(key), { force: true })
    return false
  }

  // SAFETY: The unstorage fs-lite driver satisfies KVRuntimeDriver and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver
  const { getItem, getItemRaw, getMeta, hasItem, removeItem, setItem, setItemRaw } = driver
  driver.getItem = async (key, operationOptions) => {
    if (!await live(key)) return null
    const value = await getItem(fileName(key), operationOptions)
    if (value instanceof Error) throw value
    return value
  }
  driver.getItemRaw = async (key, operationOptions) => {
    if (!await live(key)) return null
    const value = await getItemRaw?.(fileName(key), operationOptions)
    if (value instanceof Error) throw value
    return value
  }
  driver.getMeta = async (key, operationOptions) => await live(key) ? getMeta?.(fileName(key), operationOptions) ?? null : null
  driver.setItem = async (key, value, operationOptions) => {
    await writeExpiry(key, setExpiry(operationOptions))
    return setItem?.(fileName(key), value, operationOptions)
  }
  driver.setItemRaw = async (key, value, operationOptions) => {
    await writeExpiry(key, setExpiry(operationOptions))
    return setItemRaw?.(fileName(key), value, operationOptions)
  }
  driver.removeItem = async (key, operationOptions) => {
    await rm(expiryPath(key), { force: true })
    await removeItem?.(fileName(key), operationOptions)
  }
  driver.clear = async (base = "") => {
    const entries = await readdir(root).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return []
      throw error
    })
    for (const entry of entries) {
      const key = keyOf(entry)
      if (key !== undefined && key.startsWith(base)) {
        await rm(join(root, entry), { force: true, recursive: true })
        await rm(expiryPath(key), { force: true })
      }
    }
  }
  const hasLiveItem: typeof driver.hasItem = async (key, operationOptions) => {
    if (!await hasItem(fileName(key), operationOptions)) return false
    if (!await live(key)) return false
    try {
      return (await stat(join(root, fileName(key)))).isFile()
    }
    catch (error) {
      if (hasCode(error, "ENOENT")) return false
      throw error
    }
  }
  driver.hasItem = hasLiveItem
  driver.setIfAbsentItem = async (key, value, ttl) => {
    const expiresAt = ttl === undefined ? undefined : Date.now() + ttlMilliseconds(ttl)
    if (await hasLiveItem(key, {})) return false
    const path = join(root, fileName(key))
    await mkdir(root, { recursive: true })
    const temporary = join(root, `.unstorage-tmp-${randomUUID()}`)
    await writeFile(temporary, value, "utf8")
    try {
      await link(temporary, path)
      await writeExpiry(key, expiresAt)
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
      if (entry.name === basename(layout) || layoutRecord.test(entry.name)) continue
      const key = entry.isFile() ? keyOf(entry.name) : undefined
      yield key !== undefined && await synchronized(() => live(key)) ? key : undefined
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
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVPageOptions) => {
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
  for (const name of ["getItem", "getItemRaw", "getMeta", "hasItem", "setItem", "setItemRaw", "removeItem", "clear", "setIfAbsentItem"] as const) {
    const operation = driver[name]
    if (operation) {
      // SAFETY: Each wrapper preserves the original method's arguments and result.
      Reflect.set(driver, name, (...args: unknown[]) => synchronized(async () => Reflect.apply(operation, driver, args)))
    }
  }
  return driver
}
