/// <reference path="../virtual-module.d.ts" />

import { readEnv } from "@vite-hub/internal/env"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeKVOptions } from "../config.ts"
import { kvResult } from "../errors.ts"
import type { KVOperation, KVResult, KVStorage, KVStoreName, ResolvedKVModuleOptions } from "../types.ts"
import { createHostedKVStorage, createNamedHostedKVStorage, KVStoreConfigurationError, type RuntimeStorage } from "./hosted-storage.ts"

const storagePromises = new Map<string, Promise<RuntimeStorage>>()

function inferHosting(env: Record<string, string | undefined>) {
  if (getActiveCloudflareEnv()) {
    return "cloudflare"
  }

  const explicit = readEnv(env, "VITEHUB_HOSTING")
  if (explicit) {
    return explicit
  }

  if (typeof (globalThis as { Deno?: { openKv?: unknown } }).Deno?.openKv === "function") {
    return "deno"
  }

  return readEnv(env, "KV_REST_API_URL") ? "vercel" : undefined
}

function shouldFallbackHostedConfigImport(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED"
    || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME"
}

async function resolveHostedConfig(): Promise<false | ResolvedKVModuleOptions | undefined> {
  try {
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
  const existing = storagePromises.get(name)
  if (existing) return existing
  const env = typeof process !== "undefined" ? process.env : {}
  if (inferHosting(env) === "vercel") {
    const promise = resolveHostedConfig().then(config =>
      name === "default"
        ? createHostedKVStorage(config)
        : createNamedHostedKVStorage(config, name),
    )
    storagePromises.set(name, promise)
    return promise
  }
  const promise = resolveHostedConfig().then(config =>
    name === "default"
      ? createHostedKVStorage(config)
      : createNamedHostedKVStorage(config, name),
  )
  storagePromises.set(name, promise)
  return promise
}

async function runKVOperation<TResult>(
  operation: KVOperation,
  name: string,
  run: (storage: RuntimeStorage) => Promise<TResult>,
): Promise<KVResult<TResult>> {
  const result = await kvResult(operation, name, async () => run(await resolveStorage(name)))
  if (result[0]?.cause instanceof KVStoreConfigurationError) throw result[0].cause
  return result
}

function createKVStorage(name = "default"): KVStorage {
  return {
    async clear(base, options) { return runKVOperation("clear", name, async storage => storage.clear(base, options)) },
    async del(key, options) { return runKVOperation("del", name, async storage => storage.removeItem(key, options)) },
    async get(key, options) { return runKVOperation("get", name, storage => storage.getItem(key, options)) },
    async has(key, options) { return runKVOperation("has", name, storage => storage.hasItem(key, options)) },
    async keys(base, options) { return runKVOperation("keys", name, storage => storage.getKeys(base, options)) },
    async set(key, value, options) { return runKVOperation("set", name, async storage => storage.setItem(key, value, options)) },
    store(storeName: KVStoreName) { return createKVStorage(storeName) },
  }
}

export const kv: KVStorage = createKVStorage()
