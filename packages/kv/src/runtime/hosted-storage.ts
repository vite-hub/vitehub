import { createStorage } from "unstorage"

import type { KVStorage, ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

export interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

function assertHostedConfig(config: false | ResolvedKVModuleOptions | undefined): ResolvedKVModuleOptions {
  if (!config) {
    throw new Error("[vitehub] `@vitehub/kv` requires `hubKv()` and `kv !== false`.")
  }

  return config
}

export function createHostedKVStorage(config: false | ResolvedKVModuleOptions | undefined): KVStorage {
  const storage = createStorage({
    driver: createLazyKVRuntimeDriver(assertHostedConfig(config)),
  }) as RuntimeStorage

  return {
    async clear(base, options) { await storage.clear(base, options) },
    async del(key, options) { await storage.removeItem(key, options) },
    async get(key, options) { return await storage.getItem(key, options) },
    async has(key, options) { return await storage.hasItem(key, options) },
    async keys(base, options) { return await storage.getKeys(base, options) },
    async set(key, value, options) { await storage.setItem(key, value, options) },
  }
}
