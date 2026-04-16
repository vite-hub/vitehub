import type { KVStorage } from "../types.ts"

let runtimeStore: KVStorage | undefined

export function resetKVRuntimeState(): void {
  runtimeStore = undefined
  storagePromise = undefined
}

interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

let storagePromise: Promise<RuntimeStorage> | undefined

async function resolveStorage() {
  storagePromise ||= import("nitro/runtime")
    .then(module => module.useStorage("kv") as RuntimeStorage)
  return await storagePromise
}

function createKVStorage(): KVStorage {
  return {
    async clear(base, options) { await (await resolveStorage()).clear(base, options) },
    async del(key, options) { await (await resolveStorage()).removeItem(key, options) },
    async get(key, options) { return await (await resolveStorage()).getItem(key, options) },
    async has(key, options) { return await (await resolveStorage()).hasItem(key, options) },
    async keys(base, options) { return await (await resolveStorage()).getKeys(base, options) },
    async set(key, value, options) { await (await resolveStorage()).setItem(key, value, options) },
  }
}

export const kv: KVStorage = runtimeStore ?? (runtimeStore = createKVStorage())
