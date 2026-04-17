import type { KVStorage } from "../types.ts"

interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

let storagePromise: Promise<RuntimeStorage> | undefined
let runtimeStore: KVStorage | undefined

export function resetKVRuntimeState(): void {
  runtimeStore = undefined
  storagePromise = undefined
}

function resolveStorage(): Promise<RuntimeStorage> {
  return storagePromise ||= import("nitro/runtime")
    .then(module => module.useStorage("kv") as RuntimeStorage)
}

function createKVStorage(): KVStorage {
  return {
    clear: async (base, options) => void await (await resolveStorage()).clear(base, options),
    del: async (key, options) => void await (await resolveStorage()).removeItem(key, options),
    get: async (key, options) => (await resolveStorage()).getItem(key, options),
    has: async (key, options) => (await resolveStorage()).hasItem(key, options),
    keys: async (base, options) => (await resolveStorage()).getKeys(base, options),
    set: async (key, value, options) => void await (await resolveStorage()).setItem(key, value, options),
  }
}

export const kv: KVStorage = runtimeStore ?? (runtimeStore = createKVStorage())
