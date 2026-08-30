import { createStorage, normalizeKey } from "unstorage"

import type { KVListOptions, KVListPage, ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

export interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors unstorage's caller-typed read contract.
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors the KV caller-typed read contract.
  getAndDeleteItem?<T = unknown>(key: string): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  incrementItem?(key: string, ttl: number): Promise<number>
  listKeys(options: KVListOptions): Promise<KVListPage>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

export class KVStoreConfigurationError extends Error {}

export class KVAtomicOperationUnsupportedError extends KVStoreConfigurationError {
  constructor(store: string) {
    super(`[vitehub] KV store "${store}" does not support atomic operations. Use Upstash or Deno KV.`)
  }
}

function assertHostedConfig(config: false | ResolvedKVModuleOptions | undefined): ResolvedKVModuleOptions {
  if (!config) {
    throw new KVStoreConfigurationError("[vitehub] `@vite-hub/kv` requires `hubKv()` and `kv !== false`.")
  }

  return config
}

function deserializeValue(value: unknown) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Hosted drivers return the serialized representation written by unstorage.
  if (typeof value !== "string") return value
  if (value === "undefined") return undefined
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- This mirrors unstorage's JSON value decoding and never trusts the result structurally.
    return JSON.parse(value)
  }
  catch {
    return value
  }
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
  const getAndDeleteItem = driver.getAndDeleteItem
  const incrementItem = driver.incrementItem
  if (getAndDeleteItem) storage.getAndDeleteItem = async key => deserializeValue(await getAndDeleteItem(normalizeKey(key)))
  if (incrementItem) storage.incrementItem = (key, ttl) => incrementItem(normalizeKey(key), ttl)
  return storage
}
