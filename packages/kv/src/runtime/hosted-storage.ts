import { createStorage } from "unstorage"

import type { ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

export interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

export class KVStoreConfigurationError extends Error {}

function assertHostedConfig(config: false | ResolvedKVModuleOptions | undefined): ResolvedKVModuleOptions {
  if (!config) {
    throw new KVStoreConfigurationError("[vitehub] `@vite-hub/kv` requires `hubKv()` and `kv !== false`.")
  }

  return config
}

export function createHostedKVStorage(config: false | ResolvedKVModuleOptions | undefined): RuntimeStorage {
  return createNamedHostedKVStorage(config, "default")
}

export function createNamedHostedKVStorage(config: false | ResolvedKVModuleOptions | undefined, name: string): RuntimeStorage {
  const resolved = assertHostedConfig(config)
  const stores = resolved.stores || { default: resolved.store }
  const store = stores[name]
  if (!store) {
    throw new KVStoreConfigurationError(`[vitehub] Unknown KV store "${name}".`)
  }
  return createStorage({
    driver: createLazyKVRuntimeDriver({ store, stores: { default: store, [name]: store } }),
  }) as RuntimeStorage
}
