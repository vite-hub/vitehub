import { destr } from "destr"
import { normalizeKey } from "unstorage"

import type { KVListOptions, KVListPage, ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"
import { normalizeKVListPrefix } from "./list-prefix.ts"
import { createKVStorage } from "./create-storage.ts"

export interface RuntimeStorage {
  dispose(): Promise<void>
  clear(base?: string, options?: unknown): Promise<void>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors unstorage's caller-typed read contract.
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors the KV caller-typed read contract.
  getAndDeleteItem?<T = unknown>(key: string, options?: { type?: "text" }): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  incrementItem?(key: string, ttl: number): Promise<number>
  listKeys(options: KVListOptions): Promise<KVListPage>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
  setIfAbsentItem?<T = unknown>(key: string, value: T, ttl?: number): Promise<boolean>
}

function assertHostedConfig(config: false | ResolvedKVModuleOptions | undefined): ResolvedKVModuleOptions {
  if (!config) throw kvErrorDiagnostics.KV_DISABLED()
  return config
}

function deserializeValue(value: unknown) {
  if (typeof value !== "string") return value
  // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- This is the decoder used by unstorage's ordinary read path.
  return destr(value)
}

function isPrimitive(value: unknown) {
  return value === null || (typeof value !== "object" && typeof value !== "function")
}

// Matches the serializer of unstorage's setItem(), so get() reads the value back as it reads a set() value.
function serializeValue(value: unknown): string {
  // set() removes a key for `undefined`; a conditional write cannot mean that.
  if (value === undefined) throw new TypeError("kv.setIfAbsent() needs a value. Use kv.del() to remove a key.")
  if (isPrimitive(value)) return String(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  if (value && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype === null || prototype === Object.prototype) return JSON.stringify(value)
    const toJSON: unknown = Reflect.get(value, "toJSON")
    if (typeof toJSON === "function") return serializeValue(toJSON.call(value))
  }
  throw new TypeError("KV cannot serialize this value.")
}

/** The line that `vite dev` prints when a store uses real data. Only `vite dev` resolves a store with `remote: true`. */
export function kvRemoteNotice(name: string, store: ResolvedKVStoreConfig): string | undefined {
  if (store.driver === "upstash" && store.remote) {
    return `[vitehub] KV store "${name}" is remote: \`vite dev\` uses the real Upstash database. Writes change real data.`
  }
  if (store.driver === "cloudflare-kv-binding" && store.remote) {
    const namespace = store.namespaceId ? ` ${store.namespaceId}` : ""
    return `[vitehub] KV store "${name}" is remote: \`vite dev\` uses the real Cloudflare KV namespace${namespace} through the \`${store.binding}\` binding. Writes change real data.`
  }
}

export function createHostedKVStorage(config: false | ResolvedKVModuleOptions | undefined, name = "default"): RuntimeStorage {
  const resolved = assertHostedConfig(config)
  const stores = resolved.stores || { default: resolved.store }
  const store = Object.hasOwn(stores, name) ? stores[name] : undefined
  if (!store) throw kvErrorDiagnostics.KV_STORE_NOT_FOUND({ store: name })
  const notice = kvRemoteNotice(name, store)
  if (notice) console.warn(notice)
  const driver = createLazyKVRuntimeDriver({ store, stores: { default: store, [name]: store } })
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- createKVStorage supplies every RuntimeStorage method; listKeys is installed immediately below.
  // SAFETY: createKVStorage supplies the base methods, and this boundary installs the required listKeys method before returning.
  const storage = createKVStorage(driver) as unknown as RuntimeStorage
  storage.listKeys = options => driver.listKeys({ ...options, prefix: normalizeKVListPrefix(options.prefix) })
  const getAndDeleteItem = driver.getAndDeleteItem
  const incrementItem = driver.incrementItem
  if (getAndDeleteItem) {
    // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This implements RuntimeStorage's caller-typed atomic read contract.
    storage.getAndDeleteItem = async <T = unknown>(key: string, options?: { type?: "text" }): Promise<T | null> => {
      const value = await getAndDeleteItem(normalizeKey(key))
      // SAFETY: kv.getAndDelete() types a `type: "text"` read as string; otherwise destr mirrors the caller-typed storage.getItem read.
      return (options?.type === "text" ? value : deserializeValue(value)) as T | null
    }
  }
  if (incrementItem) storage.incrementItem = (key, ttl) => incrementItem(normalizeKey(key), ttl)
  const setIfAbsentItem = driver.setIfAbsentItem
  if (setIfAbsentItem) storage.setIfAbsentItem = async (key, value, ttl) => setIfAbsentItem(normalizeKey(key), serializeValue(value), ttl)
  return storage
}
