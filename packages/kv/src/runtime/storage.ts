import "../virtual-module.d.ts"

import { readEnv } from "@vite-hub/internal/env"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeKVOptions } from "../config.ts"
import { kvResult } from "../errors.ts"
import type { Result } from "@vite-hub/runtime"
import type { KVErrorCode, KVOperation, KVStorage, KVStoreName, ResolvedKVModuleOptions } from "../types.ts"
import { createHostedKVStorage, type RuntimeStorage } from "./hosted-storage.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"

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

  const explicit = readEnv(env, "VITEHUB_HOSTING")
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

async function resolveHostedConfig(): Promise<false | ResolvedKVModuleOptions | undefined> {
  try {
    // SAFETY: ViteHub generates this private module from validated KV configuration.
    const module = await import("#vitehub/kv/config") as { kv: false | ResolvedKVModuleOptions }
    return module.kv
  }
  catch (error) {
    if (!shouldFallbackHostedConfigImport(error)) {
      throw error
    }
    const env = typeof process !== "undefined" ? process.env : {}
    return normalizeKVOptions(undefined, { env, hosting: inferHosting(env) }) || false
  }
}

async function resolveStorage(name = "default") {
  if (disposal) await disposal
  const existing = storagePromises.get(name)
  if (existing) return existing
  const promise = resolveHostedConfig().then(config => createHostedKVStorage(config, name))
  storagePromises.set(name, promise)
  void promise.catch(() => {
    if (storagePromises.get(name) === promise) storagePromises.delete(name)
  })
  return promise
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

function createKVStorage(name = "default"): KVStorage {
  return {
    async clear(base, options) { return runKVOperation("clear", name, async storage => storage.clear(base, options)) },
    async del(key, options) { return runKVOperation("del", name, async storage => storage.removeItem(key, options)) },
    async get(key, options) { return runKVOperation("get", name, storage => storage.getItem(key, options)) },
    async getAndDelete<T>(key: string) {
      return runKVOperation("getAndDelete", name, async (storage) => {
        if (!storage.getAndDeleteItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "getAndDelete", store: name })
        return storage.getAndDeleteItem<T>(key)
      }, ["KV_UNSUPPORTED_OPERATION"])
    },
    async has(key, options) { return runKVOperation("has", name, storage => storage.hasItem(key, options)) },
    async increment(key, ttl) {
      return runKVOperation("increment", name, async (storage) => {
        if (!storage.incrementItem) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "increment", store: name })
        if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isSafeInteger(Math.ceil(ttl))) throw kvErrorDiagnostics.KV_INVALID_TTL()
        return storage.incrementItem(key, ttl)
      }, ["KV_INVALID_TTL", "KV_UNSUPPORTED_OPERATION"])
    },
    async keys(base, options) { return runKVOperation("keys", name, storage => storage.getKeys(base, options)) },
    async list(options) {
      if (!Number.isInteger(options.limit) || options.limit <= 0) return [kvErrorDiagnostics.KV_INVALID_LIMIT(), undefined]
      return runKVOperation("list", name, storage => storage.listKeys(options), ["KV_INVALID_CURSOR"])
    },
    async set(key, value, options) { return runKVOperation("set", name, async storage => storage.setItem(key, value, options)) },
    store(storeName: KVStoreName) { return createKVStorage(storeName) },
  }
}

export const kv: KVStorage = createKVStorage()
