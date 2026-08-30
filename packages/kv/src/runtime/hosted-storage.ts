import { createStorage } from "unstorage"

import type { KVListOptions, KVListPage, ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

export interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors unstorage's caller-typed read contract.
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  listKeys(options: KVListOptions): Promise<KVListPage>
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
  const driver = createLazyKVRuntimeDriver({ store, stores: { default: store, [name]: store } })
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- createStorage supplies every RuntimeStorage method; listKeys is installed immediately below.
  // SAFETY: createStorage supplies the base methods, and this boundary installs the required listKeys method before returning.
  const storage = createStorage({ driver }) as unknown as RuntimeStorage
  storage.listKeys = options => driver.listKeys(options)
  return storage
}
