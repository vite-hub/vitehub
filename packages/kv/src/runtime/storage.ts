import "../virtual-module.d.ts"

import { readEnv } from "@vite-hub/internal/env"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeKVOptions } from "../config.ts"
import { kvKeyLimitCodes, kvResult, kvWriteLimitCodes } from "../errors.ts"
import type { Result } from "@vite-hub/runtime"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import type { KVDriver, KVErrorCode, KVOperation, KVSetOptions, KVStorage, KVStoreName, KVStoreOptions, ReadonlyKVStorage, ResolvedKVModuleOptions } from "../types.ts"
import { createHostedKVStorage, resolveHostedKVStore, type RuntimeStorage } from "./hosted-storage.ts"
import type { KVDatabasesLoader } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { kvStoreWithMode } from "../store-mode.ts"
import { createKVLock } from "./lock.ts"

const storagePromises = new Map<string, Promise<RuntimeStorage>>()
let disposal: Promise<void> | undefined

/** Releases every cached store. Call from the application's shutdown hook after stopping new work. */
export function disposeKVStores(): Promise<void> {
  if (disposal) return disposal
  const stores = [...storagePromises.values()]
  storagePromises.clear()
  const pending = Promise.allSettled(stores.map(async (promise) => {
    // Initialization failures already reach the operation caller and own no storage.
    const storage = await promise.catch(() => undefined)
    await storage?.dispose()
  })).then((results) => {
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to dispose KV stores.")
  }).finally(() => { disposal = undefined })
  disposal = pending
  return pending
}

function inferHosting(env: Record<string, string | undefined>) {
  if (getActiveCloudflareEnv()) {
    return "cloudflare"
  }

  const explicit = readEnv(env, "VITEHUB_HOST")
  if (explicit) {
    return explicit
  }

  // SAFETY: This assertion only reads the optional Deno.openKv marker.
  if (typeof (globalThis as { Deno?: { openKv?: unknown } }).Deno?.openKv === "function") {
    return "deno"
  }

  return readEnv(env, "KV_REST_API_URL") ? "vercel" : undefined
}

function shouldFallbackHostedConfigImport(error: unknown) {
  // SAFETY: Node import errors expose an optional string code; unknown errors safely yield undefined.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED"
    || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME"
}

interface HostedConfig {
  kv: false | ResolvedKVModuleOptions | undefined
  /** Present when a store uses the `database` driver. */
  loadDatabases?: KVDatabasesLoader
}

async function resolveHostedConfig(): Promise<HostedConfig> {
  try {
    // SAFETY: ViteHub generates this private module from validated KV configuration.
    const module = await import("#vitehub/kv/config") as HostedConfig
    // Config modules from other integrations can omit `loadDatabases`.
    const loadDatabases = "loadDatabases" in module ? module.loadDatabases : undefined
    return { kv: module.kv, ...(loadDatabases ? { loadDatabases } : {}) }
  }
  catch (error) {
    if (!shouldFallbackHostedConfigImport(error)) {
      throw error
    }
    const env = typeof process !== "undefined" ? process.env : {}
    return { kv: normalizeKVOptions(undefined, { env, hosting: inferHosting(env) }) || false }
  }
}

async function resolveStorage(name = "default") {
  // In app tests, each store is a fresh fs-lite folder that the next reset deletes.
  const test = getViteHubTestMode()
  if (test) {
    resolveHostedKVStore((await resolveHostedConfig()).kv, name)
    return await test.backend(`kv:${name}`, async () => createHostedKVStorage({
      store: { base: await test.directory(`kv-${name}`), driver: "fs-lite" },
    }, "default"), storage => storage.dispose())
  }
  if (disposal) await disposal
  const existing = storagePromises.get(name)
  if (existing) return existing
  const promise = resolveHostedConfig().then(config => createHostedKVStorage(config.kv, name, config.loadDatabases))
  storagePromises.set(name, promise)
  void promise.catch(() => {
    if (storagePromises.get(name) === promise) storagePromises.delete(name)
  })
  return promise
}

/**
 * The configured driver that a store uses in this server process. App tests return `fs-lite`.
 * An unknown store throws. Reading the driver does not open a connection to the store.
 */
export async function getKVStoreDriver(name: KVStoreName = "default"): Promise<KVDriver> {
  const config = await resolveHostedConfig()
  const store = resolveHostedKVStore(config.kv, name)
  if (getViteHubTestMode()) return "fs-lite"
  return store.driver
}

async function runKVOperation<TResult, TCode extends KVErrorCode = never>(
  operation: KVOperation,
  name: string,
  run: (storage: RuntimeStorage) => Promise<TResult>,
  codes: readonly TCode[] = [],
): Promise<Result<TResult, TCode | "KV_OPERATION_FAILED">> {
  // Config errors, for example an unknown store, throw from `resolveStorage()`.
  const storage = await resolveStorage(name)
  return kvResult(operation, name, () => run(storage), codes)
}

// JavaScript callers can pass any object, so the runtime checks what the `KVSetOptions` type allows.
function readSetTTL(operation: "set" | "setIfAbsent" | "setMany", options: KVSetOptions | undefined): number | undefined {
  if (options === undefined) return
  for (const option of Object.keys(options)) {
    if (option !== "ttl") throw kvErrorDiagnostics.KV_INVALID_OPTION({ operation, option })
  }
  const ttl: unknown = options.ttl
  if (ttl === undefined) return
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || !Number.isSafeInteger(Math.ceil(ttl))) throw kvErrorDiagnostics.KV_INVALID_TTL()
  return ttl
}

function createKVStorage(name = "default"): KVStorage {
  return {
    async clear(base, options) { return runKVOperation("clear", name, async storage => storage.clear(base, options)) },
    async delete(key, options) { return runKVOperation("delete", name, async storage => storage.removeItem(key, options), kvKeyLimitCodes) },
    async deleteIfEquals(key, expected) {
      return runKVOperation("deleteIfEquals", name, async (storage) => {
        if (!storage.deleteIfEqualsItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "deleteIfEquals", store: name })
        return storage.deleteIfEqualsItem(key, expected)
      }, ["KV_UNSUPPORTED_OPERATION"])
    },
    async get(key, options) { return runKVOperation("get", name, storage => storage.getItem(key, options), kvKeyLimitCodes) },
    async getAndDelete(key, options) {
      return runKVOperation("getAndDelete", name, async (storage) => {
        if (!storage.getAndDeleteItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "getAndDelete", store: name })
        return storage.getAndDeleteItem(key, options)
      }, ["KV_UNSUPPORTED_OPERATION"])
    },
    async getMany(keys, options) { return runKVOperation("getMany", name, storage => storage.getMany(keys, options), kvKeyLimitCodes) },
    async has(key, options) { return runKVOperation("has", name, storage => storage.hasItem(key, options), kvKeyLimitCodes) },
    async increment(key, ttl) {
      return runKVOperation("increment", name, async (storage) => {
        if (!storage.incrementItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "increment", store: name })
        if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isSafeInteger(Math.ceil(ttl))) throw kvErrorDiagnostics.KV_INVALID_TTL()
        return storage.incrementItem(key, ttl)
      }, ["KV_INVALID_TTL", "KV_UNSUPPORTED_OPERATION"])
    },
    async keys(base, options) { return runKVOperation("keys", name, storage => storage.getKeys(base, options)) },
    lock(key, options) { return createKVLock(name, () => resolveStorage(name), key, options) },
    async list(options) {
      if (!Number.isInteger(options.limit) || options.limit <= 0) return [kvErrorDiagnostics.KV_INVALID_LIMIT(), undefined]
      return runKVOperation("list", name, storage => storage.listKeys(options), ["KV_INVALID_CURSOR"])
    },
    async set(key, value, options) {
      return runKVOperation("set", name, async (storage) => {
        const ttl = readSetTTL("set", options)
        return storage.setItem(key, value, ttl === undefined ? undefined : { ttl })
      }, [...kvWriteLimitCodes, "KV_INVALID_OPTION", "KV_INVALID_TTL"])
    },
    async setMany(entries, options) {
      return runKVOperation("setMany", name, async (storage) => {
        const ttl = readSetTTL("setMany", options)
        return storage.setMany(entries, ttl === undefined ? undefined : { ttl })
      }, [...kvWriteLimitCodes, "KV_INVALID_OPTION", "KV_INVALID_TTL"])
    },
    async setIfAbsent(key, value, options) {
      return runKVOperation("setIfAbsent", name, async (storage) => {
        if (!storage.setIfAbsentItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "setIfAbsent", store: name })
        return storage.setIfAbsentItem(key, value, readSetTTL("setIfAbsent", options))
      }, ["KV_INVALID_OPTION", "KV_INVALID_TTL", "KV_UNSUPPORTED_OPERATION"])
    },
    store: selectKVStore,
  }
}

function selectKVStore(name: KVStoreName, options?: { mode?: "write" }): KVStorage
function selectKVStore(name: KVStoreName, options: { mode: "read" }): ReadonlyKVStorage
function selectKVStore(name: KVStoreName, options?: KVStoreOptions): KVStorage | ReadonlyKVStorage
function selectKVStore(name: KVStoreName, options?: KVStoreOptions): KVStorage | ReadonlyKVStorage {
  return kvStoreWithMode(createKVStorage(name), options)
}

export const kv: KVStorage = createKVStorage()
